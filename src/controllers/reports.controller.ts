import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';

// Variance Report: Planned vs Actual Consumption and Output (REP-03)
export const getProductionVarianceReport = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;

    if (!isSupabaseConfigured) {
      return res.json({ success: true, report: [] });
    }

    const { data: batches, error } = await supabase
      .from('production_batches')
      .select(`
        batch_number, planned_quantity_kg, actual_input_kg, accepted_output_kg,
        waste_kg, rejected_kg, status, completion_time,
        products (code, name),
        production_material_consumption (
          planned_quantity_kg, actual_quantity_kg,
          materials (code, name)
        )
      `)
      .eq('tenant_id', tenantId)
      .eq('status', 'completed')
      .order('completion_time', { ascending: false });

    if (error) throw error;

    const report = (batches || []).map((b: any) => {
      const planned = Number(b.planned_quantity_kg);
      const actualInput = Number(b.actual_input_kg);
      const accepted = Number(b.accepted_output_kg);
      const waste = Number(b.waste_kg);
      const rejected = Number(b.rejected_kg);

      const yieldPct = actualInput > 0 ? (accepted / actualInput) * 100 : 0;
      const wastePct = actualInput > 0 ? (waste / actualInput) * 100 : 0;

      return {
        batch_number: b.batch_number,
        product_name: b.products?.name,
        planned_input_kg: planned,
        actual_input_kg: actualInput,
        accepted_output_kg: accepted,
        waste_kg: waste,
        rejected_kg: rejected,
        input_variance_kg: actualInput - planned,
        yield_percentage: Number(yieldPct.toFixed(2)),
        waste_percentage: Number(wastePct.toFixed(2)),
        materials: (b.production_material_consumption || []).map((m: any) => ({
          material_name: m.materials?.name,
          planned_kg: Number(m.planned_quantity_kg),
          actual_kg: Number(m.actual_quantity_kg),
          variance_kg: Number(m.actual_quantity_kg) - Number(m.planned_quantity_kg)
        }))
      };
    });

    return res.json({ success: true, report });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Scrap / Waste Report (REP-04)
export const getWasteReport = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;

    if (!isSupabaseConfigured) {
      return res.json({
        success: true,
        summary: { total_waste_kg: 0, total_rejected_kg: 0, total_accepted_kg: 0 },
        records: []
      });
    }

    const { data: outputs, error } = await supabase
      .from('production_outputs')
      .select(`
        *,
        production_batches (
          batch_number,
          products (name, code)
        )
      `)
      .eq('tenant_id', tenantId)
      .order('recorded_at', { ascending: false });

    if (error) throw error;

    let totalWaste = 0;
    let totalRejected = 0;
    let totalAccepted = 0;

    const records = (outputs || []).map((o: any) => {
      totalWaste += Number(o.waste_kg || 0);
      totalRejected += Number(o.rejected_kg || 0);
      totalAccepted += Number(o.accepted_kg || 0);
      return {
        id: o.id,
        batch_number: o.production_batches?.batch_number,
        product_name: o.production_batches?.products?.name,
        accepted_kg: Number(o.accepted_kg),
        waste_kg: Number(o.waste_kg),
        rejected_kg: Number(o.rejected_kg),
        recorded_at: o.recorded_at
      };
    });

    return res.json({
      success: true,
      summary: {
        total_waste_kg: totalWaste,
        total_rejected_kg: totalRejected,
        total_accepted_kg: totalAccepted
      },
      records
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Audit and Activity Log (AUD-01..AUD-06)
export const getAuditLogs = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;

    if (!isSupabaseConfigured) {
      return res.json({ success: true, logs: [] });
    }

    const { data: logs, error } = await supabase
      .from('audit_logs')
      .select('*, users(email, full_name, role)')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    return res.json({ success: true, logs });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
