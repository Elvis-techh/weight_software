// Which server a run of the app talks to, and where it keeps its local state.
// Pure logic with no Electron dependency, so it can be tested on its own; the
// sandbox launcher (scripts/dev.js) reads the sandbox address from here too.
//
// - The installed app (the weight station) always talks to production, as it
//   always has.
// - A development run (`npm start` / `npm run dev`) talks to the local sandbox
//   server, and reaches production only when asked explicitly
//   (`npm run start:prod`), so forgetting a flag can never put test data in
//   the real database.

const PRODUCTION_API_URL = 'https://api.basculacentral.com';
// Not 3000, the usual dev-server port, so it can't collide with another
// project's server running on the same computer. An IP rather than
// "localhost" so the app and the server agree on IPv4.
const SANDBOX_API_URL = 'http://127.0.0.1:3100';
const PRODUCTION_FLAG = '--production';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Only a server on this computer counts as the sandbox. Anything else is
// treated as real data, including an address that doesn't parse.
function isLocalServer(apiUrl) {
    try {
        return LOCAL_HOSTS.has(new URL(apiUrl).hostname);
    } catch (_) {
        return false;
    }
}

function resolveEnvironment({ isPackaged, argv = [], env = {} }) {
    const override = String(env.BASCULA_API_URL || '').trim().replace(/\/+$/, '');

    let apiUrl;
    if (isPackaged) apiUrl = override || PRODUCTION_API_URL;
    else if (argv.includes(PRODUCTION_FLAG)) apiUrl = PRODUCTION_API_URL;
    else apiUrl = override || SANDBOX_API_URL;

    return { apiUrl, sandbox: isLocalServer(apiUrl), devBuild: !isPackaged };
}

// Local state (the offline outbox, scale settings, localStorage) is kept apart
// per kind of server, so weighings queued against the sandbox can never be
// replayed into production, nor the other way round. Production keeps
// Electron's default folder, so the installed app's pending weighings and
// scale settings stay exactly where they are.
function userDataPath(defaultPath, { sandbox }) {
    return sandbox ? `${defaultPath}-sandbox` : defaultPath;
}

module.exports = {
    PRODUCTION_API_URL,
    SANDBOX_API_URL,
    PRODUCTION_FLAG,
    isLocalServer,
    resolveEnvironment,
    userDataPath
};
