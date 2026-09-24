import express from 'express';
import { getActivityLog, clearActivityLog } from '../controllers/activityLogController';
import passport from 'passport';

const router = express.Router();
const requireAuth = passport.authenticate('jwt', { session: false });

router.use(requireAuth);

router.get('/',    getActivityLog);
router.delete('/', clearActivityLog);

export default router;
