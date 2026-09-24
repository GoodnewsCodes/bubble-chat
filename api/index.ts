// Dynamic import so we can catch module-level initialization errors
// and surface them in the HTTP response + Vercel Runtime Logs.
let appPromise: Promise<any> | null = null;

function getApp() {
  if (!appPromise) {
    appPromise = import('../index')
      .then((m) => m.default)
      .catch((err) => {
        console.error('🔥 [MODULE INIT FAILED]:', err);
        // Reset so next cold-start retries
        appPromise = null;
        throw err;
      });
  }
  return appPromise;
}

export default async function handler(req: any, res: any) {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (err: any) {
    console.error('🔥 [HANDLER ERROR]:', err);
    res.status(500).json({
      error: 'Serverless function failed to initialize',
      message: err?.message || String(err),
      stack: err?.stack,
    });
  }
}
