import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.routes';
import materialsRoutes from './routes/materials.routes';
import productsRoutes from './routes/products.routes';
import ordersRoutes from './routes/orders.routes';
import productionRoutes from './routes/production.routes';
import finishedGoodsRoutes from './routes/finishedGoods.routes';
import dispatchRoutes from './routes/dispatch.routes';
import traceabilityRoutes from './routes/traceability.routes';
import reportsRoutes from './routes/reports.routes';
import tenantRoutes from './routes/tenant.routes';
import sizeMicronRoutes from './routes/sizeMicron.routes';
import jobWorkRoutes from './routes/jobWork.routes';
import scrapRoutes from './routes/scrap.routes';

const app = express();

app.use(cors());
app.use(express.json());

// API Endpoints
app.use('/api/auth', authRoutes);
app.use('/api/materials', materialsRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/production', productionRoutes);
app.use('/api/finished-goods', finishedGoodsRoutes);
app.use('/api/dispatch', dispatchRoutes);
app.use('/api/traceability', traceabilityRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/size-microns', sizeMicronRoutes);
app.use('/api/job-work', jobWorkRoutes);
app.use('/api/scrap', scrapRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    system: 'Shri Hari Packaging ERP API',
    version: '1.1',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Shri Hari Packaging ERP Multi-Tenant API is running',
    version: '1.1'
  });
});

export default app;
