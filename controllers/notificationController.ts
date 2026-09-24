import { Request, Response } from 'express';
import { Notification, INotification, NotificationType } from '../models/notification';
import mongoose from 'mongoose';
import { sendPushNotification } from '../utils/push';

// ─── Internal helper — called by other controllers ────────────────────────────

export const createNotification = async (data: {
  recipient: mongoose.Types.ObjectId | string;
  sender?: mongoose.Types.ObjectId | string;
  type: NotificationType;
  title: string;
  body: string;
  entityId?: string;
  entityType?: string;
  data?: Record<string, any>;
}): Promise<INotification | null> => {
  try {
    const notif = await Notification.create(data);
    
    // Trigger push notification asynchronously
    sendPushNotification([data.recipient], data.title, data.body, {
      notificationId: notif._id.toString(),
      type: data.type,
      entityId: data.entityId || '',
      entityType: data.entityType || '',
    }).catch(err => console.error('[Push] createNotification hook failed:', err));

    return notif;
  } catch (err) {
    console.error('❌ createNotification failed:', err);
    return null;
  }
};

// ─── GET /api/v1/notifications ────────────────────────────────────────────────
export const getNotifications = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const page  = parseInt((req.query.page as string) || '1');
    const limit = parseInt((req.query.limit as string) || '30');
    const skip  = (page - 1) * limit;

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find({ recipient: userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('sender', 'full_name username avatar uniqueTag')
        .lean(),
      Notification.countDocuments({ recipient: userId }),
      Notification.countDocuments({ recipient: userId, read: false }),
    ]);

    res.status(200).json({ notifications, total, unreadCount, page, limit });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to fetch notifications', error: err.message });
  }
};

// ─── GET /api/v1/notifications/unread-count ───────────────────────────────────
export const getUnreadCount = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const count = await Notification.countDocuments({ recipient: userId, read: false });
    res.status(200).json({ count });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to count notifications', error: err.message });
  }
};

// ─── PUT /api/v1/notifications/:id/read ──────────────────────────────────────
export const markOneRead = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const notif = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: userId },
      { read: true },
      { returnDocument: 'after' }
    );

    if (!notif) return res.status(404).json({ message: 'Notification not found' });
    res.status(200).json({ message: 'Marked as read', notification: notif });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to mark notification', error: err.message });
  }
};

// ─── PUT /api/v1/notifications/read-all ──────────────────────────────────────
export const markAllRead = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    await Notification.updateMany({ recipient: userId, read: false }, { read: true });
    res.status(200).json({ message: 'All notifications marked as read' });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to mark all notifications', error: err.message });
  }
};

// ─── DELETE /api/v1/notifications/:id ────────────────────────────────────────
export const deleteNotification = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const notif = await Notification.findOneAndDelete({ _id: req.params.id, recipient: userId });
    if (!notif) return res.status(404).json({ message: 'Notification not found' });

    res.status(200).json({ message: 'Notification deleted' });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to delete notification', error: err.message });
  }
};

// ─── DELETE /api/v1/notifications ────────────────────────────────────────────
export const clearAllNotifications = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    await Notification.deleteMany({ recipient: userId });
    res.status(200).json({ message: 'All notifications cleared' });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to clear notifications', error: err.message });
  }
};
