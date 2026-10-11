import { Router } from 'express';
import {
  getTenants,
  createTenant,
  updateTenantStatus
} from '../controllers/tenant.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.use(requireRole('platform_admin'));

router.get('/', getTenants);
router.post('/', createTenant);
router.patch('/:id/status', updateTenantStatus);

export default router;
