import { Router } from 'express';
import {
  getDeliveries,
  createAndConfirmDispatch
} from '../controllers/dispatch.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);

router.get('/', getDeliveries);
router.post('/confirm', requireRole('factory_admin', 'supervisor', 'dispatch_manager'), createAndConfirmDispatch);

export default router;
