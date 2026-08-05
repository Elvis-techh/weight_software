const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

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
const client = configured
    ? new S3Client({
        endpoint: SPACES_ENDPOINT,
        region: SPACES_REGION,
        credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET }
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
    const result = await client.send(new GetObjectCommand({ Bucket: SPACES_BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of result.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
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
