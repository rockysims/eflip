// api.js: the /api and /sso routes the browser pages use for server-side features.
//
// The server listens on 127.0.0.1 only, but that alone is not enough: a web page the user has
// open can still reach it by DNS rebinding (a hostname that later resolves to 127.0.0.1) or by a
// cross-site request, and so can any other local process. Two guards answer 403 to those:
//   - Host must be a loopback name, which defeats DNS rebinding (the rebound request carries the
//     attacker's hostname in Host).
//   - Origin, when the browser sends one, must be this very server (same host and port), which
//     defeats cross-site requests. No Access-Control-* header is ever set, so browsers also refuse
//     to hand responses to other origins.
const express = require('express');

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

// Hostname part of a Host header value without its port; handles `[::1]:5001`. null when empty.
const hostnameOf = (hostHeader) => {
	if (typeof hostHeader !== 'string' || hostHeader === '') return null;
	if (hostHeader.startsWith('[')) {
		const end = hostHeader.indexOf(']');
		return end === -1 ? null : hostHeader.slice(1, end);
	}
	return hostHeader.split(':')[0];
};

const hostGuard = (req, res, next) => {
	const hostname = hostnameOf(req.headers.host);
	if (hostname === null || !LOCAL_HOSTNAMES.has(hostname.toLowerCase())) {
		return res.status(403).json({error: 'forbidden host'});
	}
	next();
};

const originGuard = (req, res, next) => {
	const origin = req.headers.origin;
	if (origin === undefined) return next();
	let originHost = null;
	try {
		originHost = new URL(origin).host;
	} catch (e) {
		// unparsable: falls through to the 403 below
	}
	if (originHost === null || originHost !== req.headers.host) {
		return res.status(403).json({error: 'forbidden origin'});
	}
	next();
};

const mountApi = (app) => {
	const router = express.Router();
	// Guards cover both prefixes, so routes added below must live under /api or /sso.
	router.use(['/api', '/sso'], hostGuard, originGuard);

	router.get('/api/health', (req, res) => res.json({ok: true}));

	app.use(router);
};

module.exports = { mountApi };
