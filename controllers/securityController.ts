import { Request, Response } from 'express';
import { SecurityCode } from '../models/security';

// ─── Format helper ─────────────────────────────────────────────────────────────

const formatSecurityCode = (code: any) => ({
  id: code._id,
  code: code.code,
  isCurrent: code.isCurrent,
  generatedAt: code.createdAt || null,
  expiresAt: code.expiresAt || null,
  remainingSeconds: code.expiresAt
    ? Math.max(0, Math.floor((new Date(code.expiresAt).getTime() - Date.now()) / 1000))
    : null,
});

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * Get the current weekly security code
 * GET /api/v1/security/current
 */
export const getCurrentSecurityCode = async (req: Request, res: Response): Promise<void> => {
  try {
    const currentCode = await SecurityCode.findOne({ isCurrent: true });

    if (!currentCode) {
      res.status(404).json({ message: 'No active security transmission found' });
      return;
    }

    res.status(200).json({
      message: 'Active security code retrieved successfully.',
      security: formatSecurityCode(currentCode),
    });
  } catch (error: any) {
    res.status(500).json({ message: 'Security System Error: ' + error.message });
  }
};
