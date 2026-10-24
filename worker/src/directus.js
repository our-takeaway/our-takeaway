import { FormData } from 'undici';
import { slowFetch } from './http.js';

// Small Directus REST client (admin static token).

const base = () => (process.env.DIRECTUS_URL || 'http://directus:8055').replace(/\/$/, '');
const auth = () => ({ Authorization: `Bearer ${process.env.DIRECTUS_TOKEN}` });

export async function directus(method, path, body) {
	const res = await slowFetch(base() + path, {
		method,
		headers: { ...auth(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`Directus ${method} ${path} failed (${res.status}): ${text}`);
	return text ? JSON.parse(text).data : null;
}

export const getPost = (id) => directus('GET', `/items/posts/${encodeURIComponent(id)}`);
export const updatePost = (id, data) => directus('PATCH', `/items/posts/${encodeURIComponent(id)}`, data);
export const createPost = (data) => directus('POST', '/items/posts', data);
export const getSettings = () => directus('GET', '/items/writer_settings');

export async function fileInfo(id) {
	return directus('GET', `/files/${encodeURIComponent(id)}?fields=id,filename_download,type,filesize`);
}

export async function downloadFile(id) {
	const res = await slowFetch(`${base()}/assets/${encodeURIComponent(id)}`, { headers: auth() });
	if (!res.ok) throw new Error(`Could not read file ${id} from Directus (${res.status}).`);
	return Buffer.from(await res.arrayBuffer());
}

export async function uploadFile(filename, buffer, type = 'application/octet-stream', title) {
	const form = new FormData();
	if (title) form.append('title', title);
	form.append('file', new Blob([buffer], { type }), filename);
	const res = await slowFetch(base() + '/files', { method: 'POST', headers: auth(), body: form });
	const text = await res.text();
	if (!res.ok) throw new Error(`Uploading ${filename} to Directus failed (${res.status}): ${text}`);
	return JSON.parse(text).data.id;
}

export const cmsLink = (id) => `${(process.env.DIRECTUS_PUBLIC_URL || base()).replace(/\/$/, '')}/admin/content/posts/${id}`;
