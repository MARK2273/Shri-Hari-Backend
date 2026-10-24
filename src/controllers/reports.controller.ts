import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { mockStore } from '../utils/mockStore';

const getTenantId = (req: Request): string =>
  (req.tenantId || process.env.DEFAULT_TENANT_SLUG || 'shri-hari-pack') as string;

// Variance Report: Planned vs Actual Consumption and Output (REP-03)
export const getProductionVarianceReport = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    if (!isSupabaseConfigured) {
      const batches = mockStore.productionBatches.filter(
        (b: any) => b.tenant_id === tenantId
      );

      const report = batches.map((b: any) => {
        const prod = mockStore.products.find((p: any) => p.id === b.product_id) || b.products;
        const outputs = b.production_outputs?.[0];
        const plannedInput = Number(b.planned_quantity_kg || 0);

        const consumption = b.production_material_consumption || [];
        const actualInput =
          consumption.reduce((sum: number, c: any) => sum + (Number(c.actual_quantity_kg) || 0), 0) ||
          plannedInput;

        const acceptedOutput = Number(
          outputs?.accepted_kg ?? b.accepted_output_kg ?? (b.status === 'completed' ? plannedInput : 0)
        );
        const trimWasteKg = Number(outputs?.trim_waste_kg ?? b.trim_waste_kg ?? 0);
        const plantWasteKg = Number(outputs?.plant_waste_kg ?? b.plant_waste_kg ?? 0);
        const wasteKg = Number(outputs?.waste_kg ?? b.waste_kg ?? (trimWasteKg + plantWasteKg));
        const rejectedKg = Number(outputs?.rejected_kg ?? b.rejected_kg ?? 0);

        const yieldPct =
          actualInput > 0
            ? Number(((acceptedOutput / actualInput) * 100).toFixed(2))
            : b.status === 'completed'
            ? 100
            : 0;
        const wastePct =
          actualInput > 0 ? Number(((wasteKg / actualInput) * 100).toFixed(2)) : 0;

        return {
          batch_number: b.batch_number,
          product_name: prod?.name || 'Finished Product',
          planned_input_kg: plannedInput,
          actual_input_kg: actualInput,
          accepted_output_kg: acceptedOutput,
          trim_waste_kg: trimWasteKg,
          plant_waste_kg: plantWasteKg,
          waste_kg: wasteKg,
          rejected_kg: rejectedKg,
          input_variance_kg: actualInput - plannedInput,
          yield_percentage: yieldPct,
          waste_percentage: wastePct,
          materials: consumption.map((m: any) => {
            const mat = mockStore.materials.find((x: any) => x.id === m.material_id) || m.materials;
            const pKg = Number(m.planned_quantity_kg || 0);
            const aKg = Number(m.actual_quantity_kg || pKg);
            return {
              material_name: mat?.name || 'Polymer',
              planned_kg: pKg,
              actual_kg: aKg,
              variance_kg: aKg - pKg,
            };
          }),
        };
      });

      return res.json({ success: true, report });
    }

    const { data: batches, error } = await supabase
      .from('production_batches')
      .select(`
        batch_number, planned_quantity_kg, actual_input_kg, accepted_output_kg,
        trim_waste_kg, plant_waste_kg, waste_kg, rejected_kg, status, completion_time,
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
      const trimWaste = Number(b.trim_waste_kg || 0);
      const plantWaste = Number(b.plant_waste_kg || 0);
      const waste = Number(b.waste_kg || (trimWaste + plantWaste));
      const rejected = Number(b.rejected_kg);

      const yieldPct = actualInput > 0 ? (accepted / actualInput) * 100 : 0;
      const wastePct = actualInput > 0 ? (waste / actualInput) * 100 : 0;

      return {
        batch_number: b.batch_number,
        product_name: b.products?.name,
        planned_input_kg: planned,
        actual_input_kg: actualInput,
        accepted_output_kg: accepted,
        trim_waste_kg: trimWaste,
        plant_waste_kg: plantWaste,
        waste_kg: waste,
        rejected_kg: rejected,
        input_variance_kg: actualInput - planned,
        yield_percentage: Number(yieldPct.toFixed(2)),
        waste_percentage: Number(wastePct.toFixed(2)),
        materials: (b.production_material_consumption || []).map((m: any) => ({
          material_name: m.materials?.name,
          planned_kg: Number(m.planned_quantity_kg),
          actual_kg: Number(m.actual_quantity_kg),
          variance_kg: Number(m.actual_quantity_kg) - Number(m.planned_quantity_kg),
        })),
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
    const tenantId = getTenantId(req);

    if (!isSupabaseConfigured) {
      const batches = mockStore.productionBatches.filter((b: any) => b.tenant_id === tenantId);

      let totalTrimWaste = 0;
      let totalPlantWaste = 0;
      let totalWaste = 0;
      let totalRejected = 0;
      let totalAccepted = 0;

      const records = batches
        .filter((b: any) => b.status === 'completed' || b.production_outputs?.length > 0)
        .map((b: any) => {
          const prod = mockStore.products.find((p: any) => p.id === b.product_id) || b.products;
          const outputs = b.production_outputs?.[0];
          const accepted = Number(outputs?.accepted_kg ?? b.accepted_output_kg ?? b.planned_quantity_kg);
          const trimWaste = Number(outputs?.trim_waste_kg ?? b.trim_waste_kg ?? 0);
          const plantWaste = Number(outputs?.plant_waste_kg ?? b.plant_waste_kg ?? 0);
          const waste = Number(outputs?.waste_kg ?? b.waste_kg ?? (trimWaste + plantWaste));
          const rejected = Number(outputs?.rejected_kg ?? b.rejected_kg ?? 0);

          totalAccepted += accepted;
          totalTrimWaste += trimWaste;
          totalPlantWaste += plantWaste;
          totalWaste += waste;
          totalRejected += rejected;

          return {
            id: outputs?.id || `out-${b.id}`,
            batch_number: b.batch_number,
            product_name: prod?.name || 'Packaging Film',
            accepted_kg: accepted,
            trim_waste_kg: trimWaste,
            plant_waste_kg: plantWaste,
            waste_kg: waste,
            rejected_kg: rejected,
            recorded_at: outputs?.recorded_at || b.end_time || b.created_at,
          };
        });

      return res.json({
        success: true,
        summary: {
          total_trim_waste_kg: totalTrimWaste,
          total_plant_waste_kg: totalPlantWaste,
          total_waste_kg: totalWaste,
          total_rejected_kg: totalRejected,
          total_accepted_kg: totalAccepted,
        },
        records,
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

    let totalTrimWaste = 0;
    let totalPlantWaste = 0;
    let totalWaste = 0;
    let totalRejected = 0;
    let totalAccepted = 0;

    const records = (outputs || []).map((o: any) => {
      const trimWaste = Number(o.trim_waste_kg || 0);
      const plantWaste = Number(o.plant_waste_kg || 0);
      const waste = Number(o.waste_kg || (trimWaste + plantWaste));
      const accepted = Number(o.accepted_kg || 0);
      const rejected = Number(o.rejected_kg || 0);

      totalTrimWaste += trimWaste;
      totalPlantWaste += plantWaste;
      totalWaste += waste;
      totalRejected += rejected;
      totalAccepted += accepted;

      return {
        id: o.id,
        batch_number: o.production_batches?.batch_number,
        product_name: o.production_batches?.products?.name,
        accepted_kg: accepted,
        trim_waste_kg: trimWaste,
        plant_waste_kg: plantWaste,
        waste_kg: waste,
        rejected_kg: rejected,
        recorded_at: o.recorded_at,
      };
    });

    return res.json({
      success: true,
      summary: {
        total_trim_waste_kg: totalTrimWaste,
        total_plant_waste_kg: totalPlantWaste,
        total_waste_kg: totalWaste,
        total_rejected_kg: totalRejected,
        total_accepted_kg: totalAccepted,
      },
      records,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Audit and Activity Log (AUD-01..AUD-06)
export const getAuditLogs = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    if (!isSupabaseConfigured) {
      if (mockStore.auditLogs.length === 0) {
        mockStore.customers.forEach((c: any) => {
          mockStore.auditLogs.push({
            id: `aud-cust-${c.id}`,
            action: 'CREATE_CUSTOMER',
            entity_name: `Customer: ${c.name} (${c.code})`,
            user_email: 'admin@shrihari.com',
            created_at: c.created_at,
          });
        });
        mockStore.orders.forEach((o: any) => {
          mockStore.auditLogs.push({
            id: `aud-ord-${o.id}`,
            action: 'CREATE_CUSTOMER_ORDER',
            entity_name: `Order: ${o.order_number} (${o.total_requested_weight_kg} kg)`,
            user_email: 'admin@shrihari.com',
            created_at: o.created_at,
          });
        });
        mockStore.productionBatches.forEach((b: any) => {
          mockStore.auditLogs.push({
            id: `aud-pb-${b.id}`,
            action: b.status === 'completed' ? 'CONFIRM_PRODUCTION_RUN' : 'LAUNCH_PRODUCTION_BATCH',
            entity_name: `Batch: ${b.batch_number} (${b.planned_quantity_kg} kg)`,
            user_email: 'admin@shrihari.com',
            created_at: b.created_at,
          });
        });
        mockStore.auditLogs.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      }

      return res.json({ success: true, logs: mockStore.auditLogs });
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
