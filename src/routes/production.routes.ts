import { Router } from 'express';
import {
  getProductionBatches,
  createProductionBatch,
  confirmProductionBatch,
  updateProductionBatchOperator
} from '../controllers/production.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);

router.get('/', getProductionBatches);
router.post('/', requireRole('factory_admin', 'supervisor', 'operator'), createProductionBatch);
router.post('/:batchId/confirm', requireRole('factory_admin', 'supervisor', 'operator'), confirmProductionBatch);
router.patch('/:batchId/operator', requireRole('factory_admin', 'supervisor', 'operator'), updateProductionBatchOperator);

export default router;
