import app from '../index';

export default async function handler(req: any, res: any) {
  try {
    return app(req, res);
  } catch (err: any) {
    console.error('🔥 [Vercel Function Error]:', err);
    return res.status(500).json({
      error: 'Vercel Serverless Invocation Failure',
      message: err?.message || String(err),
      stack: err?.stack,
    });
  }
}
