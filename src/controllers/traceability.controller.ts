import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';

// Full End-to-End Traceability (REP-07)
export const getTraceability = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    const { batchNumber, orderNumber, lotNumber } = req.query;

    if (!isSupabaseConfigured) {
      return res.json({
        success: true,
        traceability: {
          customer_order: {
            order_number: 'ORD-20261011-001',
            customer_name: 'Gujarat Cooperative Milk Federation (Amul)',
            required_delivery_date: '2026-10-18',
            status: 'completed'
          },
          production_batch: {
            batch_number: 'PB-20261011-001',
            product_name: 'Multi-Layer Co-Extruded Milk Pouch Film 500ml',
            planned_kg: 200.0,
            actual_input_kg: 200.0,
            accepted_output_kg: 194.0,
            waste_kg: 6.0,
            operator: 'Suresh Kumar',
            supervisor: 'Vikas Patel'
          },
          raw_material_lots_consumed: [
            { material_name: 'Plastic Type A', batch_number: 'MB-20261001-A1', supplier: 'Reliance Petrochemicals', consumed_kg: 102.0 },
            { material_name: 'Plastic Type B', batch_number: 'MB-20261001-B1', supplier: 'Reliance Petrochemicals', consumed_kg: 58.0 },
            { material_name: 'Plastic Type D', batch_number: 'MB-20261005-D1', supplier: 'Indian Oil Polymers', consumed_kg: 40.0 }
          ],
          finished_goods: {
            batch_number: 'FG-PB-20261011-001',
            quantity_produced_kg: 194.0,
            quantity_dispatched_kg: 194.0
          },
          dispatch: {
            delivery_number: 'DEL-20261011-001',
            dispatch_date: '2026-10-11T12:00:00Z',
            vehicle_number: 'GJ-01-AB-1234',
            destination: 'Amul Packaging Hub, Kheda, Gujarat'
          }
        }
      });
    }

    // In connected Supabase: query production batch by batch number, order, or lot
    let query = supabase
      .from('production_batches')
      .select(`
        *,
        customer_orders (
          id, order_number, order_date, required_delivery_date, status,
          customers (name, code, delivery_address)
        ),
        products (code, name, unit),
        product_recipes (version),
        production_material_consumption (
          planned_quantity_kg, actual_quantity_kg, consumed_at,
          materials (code, name),
          material_batches (
            batch_number, supplier_lot_number, receipt_date,
            suppliers (name, code)
          )
        ),
        finished_goods_batches (
          id, batch_number, quantity_produced_kg, quantity_on_hand_kg, quantity_dispatched_kg, status
        )
      `)
      .eq('tenant_id', tenantId);

    if (batchNumber) query = query.eq('batch_number', batchNumber);

    const { data: records, error } = await query;
    if (error) throw error;

    return res.json({ success: true, records });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
