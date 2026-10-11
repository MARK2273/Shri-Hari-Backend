import { Router } from 'express';
import { getFinishedGoodsInventory } from '../controllers/finishedGoods.controller';
import { authenticateToken } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getFinishedGoodsInventory);

export default router;
