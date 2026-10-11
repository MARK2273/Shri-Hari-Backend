import { Router } from 'express';
import {
  getMaterials,
  createMaterial,
  getMaterialBatches,
  receiveMaterialBatch,
  adjustBatchStock
} from '../controllers/materials.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);

router.get('/', getMaterials);
router.post('/', requireRole('factory_admin', 'supervisor'), createMaterial);
router.get('/batches', getMaterialBatches);
router.post('/batches/receive', requireRole('factory_admin', 'supervisor', 'operator'), receiveMaterialBatch);
router.post('/batches/:batchId/adjust', requireRole('factory_admin', 'supervisor'), adjustBatchStock);

export default router;
