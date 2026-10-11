import { Router } from 'express';
import {
  getProducts,
  createProduct,
  addRecipeVersion,
  calculateRequirements
} from '../controllers/products.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);

router.get('/', getProducts);
router.post('/', requireRole('factory_admin', 'supervisor'), createProduct);
router.post('/:productId/recipes', requireRole('factory_admin', 'supervisor'), addRecipeVersion);
router.post('/calculate-requirements', calculateRequirements);

export default router;
