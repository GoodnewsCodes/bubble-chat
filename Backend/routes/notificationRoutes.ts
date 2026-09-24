import express from 'express';
import {
  getNotifications,
  getUnreadCount,
  markOneRead,
  markAllRead,
  deleteNotification,
  clearAllNotifications,
} from '../controllers/notificationController';
import passport from 'passport';

const router = express.Router();
const requireAuth = passport.authenticate('jwt', { session: false });

router.use(requireAuth);

router.get('/',            getNotifications);
router.get('/unread-count',getUnreadCount);
router.put('/read-all',    markAllRead);
router.delete('/',         clearAllNotifications);
router.put('/:id/read',    markOneRead);
router.delete('/:id',      deleteNotification);

export default router;
