// fake-timers.js: the four timer functions createRegionBookScheduler takes, backed by a list the
// test fires by hand. It lives outside test/ for the same reason esi-fake.js does. A timer is
// {id, kind: 'timeout' | 'interval', ms, fn, unrefed}; unref() marks it, as Node's would, and a
// timeout that fires leaves the list, an interval stays until cleared.

const makeFakeTimers = () => {
	let nextId = 1;
	const live = new Map();
	const add = (kind, fn, ms) => {
		const timer = { id: nextId++, kind, ms, fn, unrefed: false };
		timer.unref = () => {
			timer.unrefed = true;
			return timer;
		};
		live.set(timer.id, timer);
		return timer;
	};
	const timers = {
		setTimeout: (fn, ms) => add('timeout', fn, ms),
		setInterval: (fn, ms) => add('interval', fn, ms),
		clearTimeout: (timer) => timer && live.delete(timer.id),
		clearInterval: (timer) => timer && live.delete(timer.id),
		// what is scheduled now, oldest first
		pending: () => [...live.values()].map(({ id, kind, ms, unrefed }) => ({ id, kind, ms, unrefed })),
		// Fires the one timer of that kind (a timeout is consumed) and answers what its callback returned
		// (the scheduler returns the run's promise, so a test can await it).
		fire: (kind) => {
			const due = [...live.values()].filter(timer => timer.kind === kind);
			if (due.length !== 1) throw new Error(`expected one ${kind}, found ${due.length}`);
			if (kind === 'timeout') live.delete(due[0].id);
			return due[0].fn();
		},
	};
	return timers;
};

// The four functions alone, for createRegionBookScheduler({ ...timerFunctions(timers) }) and mountApi's `timers`.
const timerFunctions = (timers) => ({
	setTimeout: timers.setTimeout,
	setInterval: timers.setInterval,
	clearTimeout: timers.clearTimeout,
	clearInterval: timers.clearInterval,
});

module.exports = { makeFakeTimers, timerFunctions };
