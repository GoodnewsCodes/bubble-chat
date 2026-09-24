import crypto from 'crypto';

function generateToken04(
  appId: number,
  userId: string,
  secret: string,
  effectiveTimeInSeconds: number,
  payload: string = ''
): string {
  const finalAppId = appId || Number(process.env.ZEGO_APP_ID);
  const finalSecret = secret || process.env.ZEGO_SERVER_SECRET || '';

  if (!finalAppId || !finalSecret) {
    throw new Error('ZEGO_APP_ID or ZEGO_SERVER_SECRET is not configured.');
  }

  const createTime = Math.floor(Date.now() / 1000);
  const tokenInfo = {
    app_id: finalAppId,
    user_id: userId,
    nonce: Math.floor(Math.random() * 2147483647),
    ctime: createTime,
    expire: createTime + effectiveTimeInSeconds,
    payload,
  };

  const plaintextJson = JSON.stringify(tokenInfo);
  const plaintextBuffer = Buffer.from(plaintextJson, 'utf8');

  // AES-128-CBC encryption with PKCS7 padding
  const keyBuffer = Buffer.from(finalSecret, 'utf8').slice(0, 16);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', keyBuffer, iv);
  const encryptedBuffer = Buffer.concat([
    cipher.update(plaintextBuffer),
    cipher.final(),
  ]);

  // Pack: [8-byte expire][2-byte iv length][iv][2-byte ciphertext length][ciphertext]
  const expireBuf = Buffer.alloc(8);
  expireBuf.writeBigInt64BE(BigInt(tokenInfo.expire), 0);
  const ivLenBuf = Buffer.alloc(2);
  ivLenBuf.writeUInt16BE(iv.length, 0);
  const cipherLenBuf = Buffer.alloc(2);
  cipherLenBuf.writeUInt16BE(encryptedBuffer.length, 0);

  const packed = Buffer.concat([expireBuf, ivLenBuf, iv, cipherLenBuf, encryptedBuffer]);
  return '04' + packed.toString('base64');
}

export const getZegoToken = (
  userId: string,
  _roomId: string,
  expireSeconds: number = 3600
): string => {
  const appId = Number(process.env.ZEGO_APP_ID);
  const serverSecret = process.env.ZEGO_SERVER_SECRET || '';
  return generateToken04(appId, userId, serverSecret, expireSeconds);
};