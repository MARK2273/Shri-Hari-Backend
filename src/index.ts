import app from './server';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 [SERVER] Shri Hari Packaging ERP Backend running on port ${PORT}`);
  console.log(`🌐 [API] Base URL: http://localhost:${PORT}/api`);
});
