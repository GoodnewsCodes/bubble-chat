import express from 'express';
import {
  getTemplates,
  createTemplate,
  updateTemplate,
  useTemplate,
  deleteTemplate,
} from '../controllers/templateController';
import passport from 'passport';

const router = express.Router();
const requireAuth = passport.authenticate('jwt', { session: false });

router.use(requireAuth);

router.get('/',           getTemplates);
router.post('/',          createTemplate);
router.put('/:id',        updateTemplate);
router.post('/:id/use',   useTemplate);
router.delete('/:id',     deleteTemplate);

export default router;
