import { Request, Response } from 'express';
import mongoose from 'mongoose';
// Redis disabled

/**
 * Basic health check
 * @route GET /api/v1/health
 */
export const checkHealth = (req: Request, res: Response) => {
  res.status(200).json({
    status_code: 200,
    service: "Bubble Chat API",
    version: "1.0.0",
    status: "healthy",
  });
};

/**
 * Detailed health check covering DB and Cache
 * @route GET /api/v1/health/detailed
 */
export const checkHealthDetailed = async (req: Request, res: Response) => {
  try {
    // Check MongoDB Status
    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';

    // Check Redis Status (Disabled per user request)
    let cacheStatus = 'disabled';

    const overallStatus = (dbStatus === 'connected') ? 'healthy' : 'degraded';
    const statusCode = overallStatus === 'healthy' ? 200 : 503;

    res.status(statusCode).json({
      status_code: statusCode,
      service: "Bubble Chat API",
      version: "1.0.0",
      status: overallStatus,
      services: {
        database: {
          status: dbStatus
        },
        cache: {
          status: cacheStatus
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      status_code: 500,
      service: "Bubble Chat API",
      version: "1.0.0",
      status: "unhealthy",
      error: "Internal health check failed"
    });
  }
};
