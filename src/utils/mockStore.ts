import fs from 'fs';
import path from 'path';

function getDataFilePath(): string {
  const candidate1 = path.resolve(process.cwd(), 'mockData.json');
  const candidate2 = path.resolve(process.cwd(), 'src/mockData.json');
  const candidate3 = path.resolve(__dirname, '../../mockData.json');
  const candidate4 = path.resolve(__dirname, '../mockData.json');
  for (const c of [candidate1, candidate2, candidate3, candidate4]) {
    if (fs.existsSync(c)) return c;
  }
  return candidate1;
}

const DATA_FILE = getDataFilePath();

export interface MockStoreData {
  materials: any[];
  batches: any[];
  products: any[];
  customers: any[];
  orders: any[];
  productionBatches: any[];
  fgBatches: any[];
  deliveries: any[];
  auditLogs: any[];
  sizeMicrons: any[];
  suppliers: any[];
  jobWorkers: any[];
  jobWorkMaterialOutward: any[];
  jobWorkOrders: any[];
  jobWorkReceipts: any[];
}

const defaultData: MockStoreData = {
  materials: [],
  batches: [],
  products: [],
  customers: [],
  orders: [],
  productionBatches: [],
  fgBatches: [],
  deliveries: [],
  auditLogs: [],
  sizeMicrons: [],
  suppliers: [],
  jobWorkers: [],
  jobWorkMaterialOutward: [],
  jobWorkOrders: [],
  jobWorkReceipts: [],
};

function loadStore(): MockStoreData {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        materials: parsed.materials || [],
        batches: parsed.batches || [],
        products: parsed.products || [],
        customers: parsed.customers || [],
        orders: parsed.orders || [],
        productionBatches: parsed.productionBatches || [],
        fgBatches: parsed.fgBatches || [],
        deliveries: parsed.deliveries || [],
        auditLogs: parsed.auditLogs || [],
        sizeMicrons: parsed.sizeMicrons || [],
        suppliers: parsed.suppliers || [],
        jobWorkers: parsed.jobWorkers || [],
        jobWorkMaterialOutward: parsed.jobWorkMaterialOutward || [],
        jobWorkOrders: parsed.jobWorkOrders || [],
        jobWorkReceipts: parsed.jobWorkReceipts || [],
      };
    }
  } catch (err) {
    console.error('Failed to load mockData.json:', err);
  }
  return defaultData;
}

export const mockStore: MockStoreData = loadStore();

export function saveMockStore(): void {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(mockStore, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save mockData.json:', err);
  }
}

export function recordAuditLog(action: string, entityName: string, details?: any, email?: string): void {
  const log = {
    id: `aud-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    action,
    entity_name: entityName,
    user_email: email || 'admin@shrihari.com',
    details: details || null,
    created_at: new Date().toISOString(),
  };
  mockStore.auditLogs.unshift(log);
  if (mockStore.auditLogs.length > 200) {
    mockStore.auditLogs.length = 200;
  }
  saveMockStore();
}
