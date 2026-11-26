const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegionBookScheduler } = require('../lib/sync');
const { makeClock, makeLog } = require('../test-support/esi-fake');
const { makeFakeTimers, timerFunctions } = require('../test-support/fake-timers');

// createRegionBookScheduler (lib/sync.js): the hourly timer of the regional book job, with fake timers
// and a fake `sync` whose syncRegionBook records its calls. No ESI, no disk.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const ON = { EFLIP_REGION_BOOK: '1' };

const OK = { status: 'ok', pagesRead: 194, pages: 194, tokensUsed: 388, elapsedMs: 142300 };

// `answers` is a list of what each call answers: a result, an Error to reject with, or a function
// returning a promise (to keep a run pending).
const setup = ({ env = ON, answers = [], ...options } = {}) => {
	const timers = makeFakeTimers();
	const clock = makeClock();
	const log = makeLog();
	const calls = [];
	const sync = {
		syncRegionBook: (...args) => {
			calls.push(args);
			const answer = answers.length > 0 ? answers.shift() : OK;
			if (answer instanceof Error) return Promise.reject(answer);
			if (typeof answer === 'function') return answer();
			return Promise.resolve(answer);
		},
	};
	const scheduler = createRegionBookScheduler({ sync, env, log, now: clock, ...timerFunctions(timers), ...options });
	return { timers, clock, log, calls, sync, scheduler };
};

// a promise the test settles by hand
const deferred = () => {
	const d = {};
	d.promise = new Promise((resolve, reject) => {
		d.resolve = resolve;
		d.reject = reject;
	});
	return d;
};

test('without EFLIP_REGION_BOOK=1 start() sets no timer, runs nothing and says so in one line', () => {
	for (const env of [{}, { EFLIP_REGION_BOOK: '0' }, { EFLIP_REGION_BOOK: 'yes' }, { EFLIP_REGION_BOOK: 'true' }]) {
		const { timers, calls, log, scheduler } = setup({ env });
		scheduler.start();
		assert.deepEqual(timers.pending(), [], JSON.stringify(env));
		assert.deepEqual(calls, []);
		assert.deepEqual(log.lines, ['info: region book schedule: off (EFLIP_REGION_BOOK=1 takes the destination book once an hour)']);
		assert.deepEqual(scheduler.status(), { scheduled: false, running: false, nextRunAt: null, lastRun: null });
		scheduler.stop();
	}
});

test('with the flag on, the first run comes after firstDelayMs and the next ones every intervalMs; every timer is unref\'d', async () => {
	const { timers, calls, log, clock, scheduler } = setup();
	scheduler.start();
	assert.deepEqual(timers.pending().map(({ kind, ms, unrefed }) => [kind, ms, unrefed]), [['timeout', MINUTE, true]], 'one timeout, the default minute');
	assert.deepEqual(log.lines, ['info: region book schedule: on, first snapshot in 60 s, then every 60 min']);
	assert.deepEqual(calls, [], 'nothing runs at start');
	assert.deepEqual(scheduler.status(), { scheduled: true, running: false, nextRunAt: new Date(clock() + MINUTE).toISOString(), lastRun: null });

	clock.advance(MINUTE);
	const firstStart = clock();
	const first = timers.fire('timeout');
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], [], 'an unforced run: the job skips itself inside the hour');
	assert.equal(scheduler.running, true, 'running while the run is pending');
	assert.deepEqual(timers.pending().map(({ kind, ms, unrefed }) => [kind, ms, unrefed]), [['interval', HOUR, true]], 'the hourly timer starts with the first run');
	assert.equal(scheduler.status().nextRunAt, new Date(firstStart + HOUR).toISOString());
	await first;
	assert.equal(scheduler.running, false);
	assert.deepEqual(scheduler.status().lastRun, { at: new Date(firstStart).toISOString(), status: 'ok' });
	assert.equal(log.lines[1], 'info: region book schedule: ok, 194/194 pages, 388 tokens, 142.3 s');

	clock.advance(HOUR);
	await timers.fire('interval');
	assert.equal(calls.length, 2);
	clock.advance(HOUR);
	await timers.fire('interval');
	assert.equal(calls.length, 3);
	assert.equal(timers.pending().length, 1, 'still one interval');
	assert.equal(scheduler.status().nextRunAt, new Date(clock() + HOUR).toISOString());
});

test('firstDelayMs and intervalMs can be set, and a timer without unref() is accepted', async () => {
	const timers = makeFakeTimers();
	const plainTimeout = (fn, ms) => {
		const timer = timers.setTimeout(fn, ms);
		delete timer.unref; // a stand-in with no unref(), as a test double might be
		return timer;
	};
	const { scheduler, calls, log } = setup({ ...timerFunctions(timers), setTimeout: plainTimeout, firstDelayMs: 5 * MINUTE, intervalMs: 90 * MINUTE });
	scheduler.start();
	assert.deepEqual(timers.pending().map(({ kind, ms, unrefed }) => [kind, ms, unrefed]), [['timeout', 5 * MINUTE, false]]);
	assert.equal(log.lines[0], 'info: region book schedule: on, first snapshot in 5 min, then every 90 min');
	await timers.fire('timeout');
	assert.deepEqual(timers.pending().map(({ kind, ms, unrefed }) => [kind, ms, unrefed]), [['interval', 90 * MINUTE, true]]);
	assert.equal(calls.length, 1);
	scheduler.stop();
});

test('a tick that finds the previous run still pending is skipped, and the next tick after it ends runs again', async () => {
	const slow = deferred();
	const { timers, calls, log, scheduler } = setup({ answers: [() => slow.promise] });
	scheduler.start();
	const first = timers.fire('timeout');
	assert.equal(calls.length, 1);
	assert.equal(scheduler.running, true);

	const overlapped = timers.fire('interval');
	assert.equal(calls.length, 1, 'no second call while the first is pending');
	assert.equal(await Promise.race([overlapped, Promise.resolve('not yet')]), 'not yet', 'the skipped tick hands back the pending run');
	assert.equal(log.lines.at(-1), 'info: region book schedule: tick skipped, the previous run is still going');

	slow.resolve({ status: 'partial', pagesRead: 97, pages: 194, tokensUsed: 194, elapsedMs: 70000, reason: 'ESI asked to wait 30 s' });
	await first;
	assert.equal(scheduler.running, false);
	assert.equal(log.lines.at(-1), 'warn: region book schedule: partial, 97/194 pages, 194 tokens, 70.0 s - ESI asked to wait 30 s');
	assert.equal(scheduler.status().lastRun.status, 'partial');

	await timers.fire('interval');
	assert.equal(calls.length, 2, 'the schedule goes on once the run has ended');
});

test('a run that rejects is logged and the next tick still runs; a busy or skipped answer is logged with its reason', async () => {
	const { timers, calls, log, scheduler } = setup({
		answers: [new Error('disk full'), { status: 'busy', reason: 'another market sync is running' }, { status: 'skipped', reason: 'a snapshot was folded within the last hour' }, OK],
	});
	scheduler.start();
	await timers.fire('timeout');
	assert.equal(log.lines.at(-1), 'warn: region book schedule: failed - disk full');
	assert.deepEqual(scheduler.status().lastRun.status, 'failed');
	assert.equal(scheduler.running, false);

	await timers.fire('interval');
	assert.equal(log.lines.at(-1), 'info: region book schedule: busy - another market sync is running');
	await timers.fire('interval');
	assert.equal(log.lines.at(-1), 'info: region book schedule: skipped - a snapshot was folded within the last hour');
	assert.equal(scheduler.status().lastRun.status, 'skipped');
	await timers.fire('interval');
	assert.equal(calls.length, 4, 'four ticks, four calls: the error did not stop the schedule');
	assert.equal(scheduler.status().lastRun.status, 'ok');
});

test('a syncRegionBook that throws at once is caught too, and does not leave the scheduler stuck pending', async () => {
	const { timers, calls, log, scheduler } = setup({
		answers: [() => {
			throw new Error('sync not ready');
		}],
	});
	scheduler.start();
	await timers.fire('timeout');
	assert.equal(log.lines.at(-1), 'warn: region book schedule: failed - sync not ready');
	assert.equal(scheduler.running, false);
	await timers.fire('interval');
	assert.equal(calls.length, 2);
});

test('stop() clears the timers, a second start() does not double them, and the schedule can start again', async () => {
	const { timers, calls, scheduler } = setup();
	scheduler.start();
	scheduler.start();
	assert.equal(timers.pending().length, 1, 'one first timer however often start() is called');
	scheduler.stop();
	assert.deepEqual(timers.pending(), []);
	assert.deepEqual(scheduler.status(), { scheduled: false, running: false, nextRunAt: null, lastRun: null });

	scheduler.start();
	await timers.fire('timeout');
	assert.equal(timers.pending().length, 1);
	scheduler.stop();
	assert.deepEqual(timers.pending(), [], 'the interval is cleared as well');
	assert.equal(calls.length, 1);
	assert.throws(() => timers.fire('interval'), /expected one interval/);
});
