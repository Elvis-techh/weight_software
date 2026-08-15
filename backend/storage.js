const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');

const SPACES_KEY = process.env.SPACES_KEY || '';
const SPACES_SECRET = process.env.SPACES_SECRET || '';
const SPACES_BUCKET = process.env.SPACES_BUCKET || '';
const SPACES_REGION = process.env.SPACES_REGION || '';
const SPACES_ENDPOINT = process.env.SPACES_ENDPOINT || '';

const configured = Boolean(SPACES_KEY && SPACES_SECRET && SPACES_BUCKET && SPACES_REGION && SPACES_ENDPOINT);

// Attachments (receipts/pdfs/images) live in DigitalOcean Spaces instead of as
// SQLite BLOBs so the droplet's disk doesn't fill up. Falls back to BLOB
// storage (see server.js) when SPACES_* env vars aren't set, so local/dev
// testing works without Spaces credentials.
//
// The AWS SDK's Node HTTP handler has NO timeout by default (DEFAULT_REQUEST_TIMEOUT
// is 0 — wait forever), so a stalled connection to Spaces would hang uploadObject()
// indefinitely. Every write route awaits storeAttachment() before responding, and
// serializeDatabaseAccess (see server.js) doesn't release its global write lock until
// the response finishes — so an unbounded hang here would freeze every terminal's
// writes (and unexempted reads) until the process is restarted. Bounding it turns
// that into a normal, recoverable request failure instead.
const client = configured
    ? new S3Client({
        endpoint: SPACES_ENDPOINT,
        region: SPACES_REGION,
        credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET },
        requestHandler: new NodeHttpHandler({ connectionTimeout: 5000, requestTimeout: 20000 }),
        // The SDK's default retry strategy would otherwise repeat a timed-out
        // attempt (each paying its own timeout) before finally giving up,
        // multiplying the worst-case hold on the write lock unpredictably.
        // One attempt keeps the bound exact: never more than ~20s.
        maxAttempts: 1
    })
    : null;

function isConfigured() {
    return configured;
}

function buildKey(folder, fileName) {
    const safeName = String(fileName || 'archivo').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
    return `${folder}/${crypto.randomUUID()}-${safeName}`;
}

async function uploadObject(folder, buffer, fileName, mimeType) {
    const key = buildKey(folder, fileName);
    await client.send(new PutObjectCommand({
        Bucket: SPACES_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: mimeType || 'application/octet-stream',
        ACL: 'private'
    }));
    return key;
}

async function fetchObject(key) {
    try {
        const result = await client.send(new GetObjectCommand({ Bucket: SPACES_BUCKET, Key: key }));
        const chunks = [];
        for await (const chunk of result.Body) chunks.push(chunk);
        return Buffer.concat(chunks);
    } catch (error) {
        // Attachment reads are deliberately unserialized (see server.js) so one slow
        // download can't stall unrelated requests — which means a read can lose a
        // narrow race against a concurrent replace that just deleted this same key.
        // Flag it so the caller can turn that into a clean 404 instead of a 500.
        if (error?.name === 'NoSuchKey' || error?.Code === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
            const notFoundError = new Error(`Objeto no encontrado en Spaces (${key}).`);
            notFoundError.notFound = true;
            throw notFoundError;
        }
        throw error;
    }
}

async function deleteObject(key) {
    if (!key) return;
    try {
        await client.send(new DeleteObjectCommand({ Bucket: SPACES_BUCKET, Key: key }));
    } catch (error) {
        console.error(`No se pudo eliminar el objeto de Spaces (${key}):`, error.message);
    }
}

module.exports = { isConfigured, uploadObject, fetchObject, deleteObject };
