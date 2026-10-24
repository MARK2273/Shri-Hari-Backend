import { Router } from 'express';
import {
  getMaterials,
  createMaterial,
  updateMaterial,
  deleteMaterial,
  seedDefaultMaterials,
  getMaterialBatches,
  receiveMaterialBatch,
  adjustBatchStock,
  getSuppliers,
} from '../controllers/materials.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);

router.get('/', getMaterials);
router.post('/', requireRole('factory_admin', 'supervisor'), createMaterial);
router.put('/:id', requireRole('factory_admin', 'supervisor'), updateMaterial);
router.delete('/:id', requireRole('factory_admin'), deleteMaterial);
router.post('/seed-defaults', requireRole('factory_admin', 'supervisor'), seedDefaultMaterials);

router.get('/suppliers', getSuppliers);
router.get('/batches', getMaterialBatches);
router.post('/batches/receive', requireRole('factory_admin', 'supervisor', 'operator'), receiveMaterialBatch);
router.post('/batches/:batchId/adjust', requireRole('factory_admin', 'supervisor'), adjustBatchStock);

export default router;
