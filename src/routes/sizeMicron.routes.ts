import { Router } from 'express';
import {
  getSizeMicrons,
  getSizeMicronById,
  createSizeMicron,
  updateSizeMicron,
  deleteSizeMicron,
} from '../controllers/sizeMicron.controller';

const router = Router();

// Master Size & Micron Routes
router.get('/', getSizeMicrons);
router.get('/:id', getSizeMicronById);
router.post('/', createSizeMicron);
router.put('/:id', updateSizeMicron);
router.delete('/:id', deleteSizeMicron);

export default router;
