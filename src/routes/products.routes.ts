import { Router } from 'express';
import {
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  seedDefaultProducts,
  addRecipeVersion,
  calculateRequirements
} from '../controllers/products.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);

router.get('/', getProducts);
router.post('/', requireRole('factory_admin', 'supervisor'), createProduct);
router.put('/:id', requireRole('factory_admin', 'supervisor'), updateProduct);
router.delete('/:id', requireRole('factory_admin', 'supervisor'), deleteProduct);
router.post('/seed-defaults', requireRole('factory_admin', 'supervisor'), seedDefaultProducts);
router.post('/:productId/recipes', requireRole('factory_admin', 'supervisor'), addRecipeVersion);
router.post('/calculate-requirements', calculateRequirements);

export default router;
