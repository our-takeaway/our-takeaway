import { Agent, fetch as undiciFetch } from 'undici';

// Node's built-in fetch gives up if a server takes more than 5 minutes to start
// answering. Transcribing an hour of audio can take longer, so allow 30 minutes.
const patient = new Agent({ headersTimeout: 30 * 60_000, bodyTimeout: 30 * 60_000, connectTimeout: 30_000 });

export const slowFetch = (url, init = {}) => undiciFetch(url, { ...init, dispatcher: patient });
