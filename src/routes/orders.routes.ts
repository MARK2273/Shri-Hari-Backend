import { Router } from 'express';
import {
  getOrders,
  createOrder,
  updateOrder,
  getCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  seedDefaultCustomers,
  increaseOrderQuantity,
} from '../controllers/orders.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);

// Customer orders
router.get('/', getOrders);
router.post('/', requireRole('factory_admin', 'supervisor'), createOrder);
router.put('/:id', requireRole('factory_admin', 'supervisor'), updateOrder);
router.patch('/:id/increase-quantity', requireRole('factory_admin', 'supervisor'), increaseOrderQuantity);
router.put('/:id/increase-quantity', requireRole('factory_admin', 'supervisor'), increaseOrderQuantity);

// Customers management
router.get('/customers', getCustomers);
router.post('/customers', requireRole('factory_admin', 'supervisor'), createCustomer);
router.put('/customers/:id', requireRole('factory_admin', 'supervisor'), updateCustomer);
router.delete('/customers/:id', requireRole('factory_admin', 'supervisor'), deleteCustomer);
router.post('/customers/seed-defaults', requireRole('factory_admin', 'supervisor'), seedDefaultCustomers);

export default router;
