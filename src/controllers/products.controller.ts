import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { z } from 'zod';
import crypto from 'crypto';
import { inMemMaterials, inMemBatches } from './materials.controller';

interface InMemRecipeItem {
  id: string;
  recipe_id: string;
  material_id: string;
  percentage: number;
  planned_kg_per_kg_output: number;
  materials?: any;
}

interface InMemRecipe {
  id: string;
  tenant_id: string;
  product_id: string;
  version: number;
  is_active: boolean;
  notes?: string;
  created_by?: string;
  effective_date: string;
  product_recipe_items: InMemRecipeItem[];
}

interface InMemProduct {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  description?: string;
  unit: string;
  standard_weight_kg: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  product_recipes: InMemRecipe[];
}

import { mockStore, saveMockStore } from '../utils/mockStore';

export let inMemProducts: InMemProduct[] = mockStore.products;

const getTenantId = (req: Request): string => (req.tenantId || process.env.DEFAULT_TENANT_SLUG || 'shri-hari-pack') as string;

// List products with active recipes (PRD-01)
export const getProducts = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    if (!isSupabaseConfigured) {
      const tenantProducts = inMemProducts.filter((p) => p.tenant_id === tenantId);
      const costMap: Record<string, number> = {};
      inMemBatches.forEach((b: any) => {
        const cost = Number(b.cost_per_kg);
        if (cost > 0) {
          costMap[b.material_id] = cost;
        }
      });

      const enriched = tenantProducts.map((p) => {
        const recipes = p.product_recipes || [];
        const activeRecipe = recipes.find((r) => r.is_active) || recipes[0] || null;
        let recipeCost = 0;
        if (activeRecipe?.product_recipe_items) {
          recipeCost = activeRecipe.product_recipe_items.reduce((sum: number, it: any) => {
            const cost = costMap[it.material_id] || 0;
            return sum + ((Number(it.percentage) || 0) / 100) * cost;
          }, 0);
        }
        return {
          ...p,
          recipe_cost_per_kg: Number(recipeCost.toFixed(2)),
          active_recipe: activeRecipe
            ? { ...activeRecipe, recipe_cost_per_kg: Number(recipeCost.toFixed(2)) }
            : null,
        };
      });
      return res.json({ success: true, products: enriched });
    }

    const { data: products, error } = await supabase
      .from('products')
      .select(`
        *,
        product_recipes (
          id, version, is_active, notes, effective_date,
          product_recipe_items (
            id, material_id, percentage, planned_kg_per_kg_output,
            materials (id, code, name, standard_unit)
          )
        )
      `)
      .eq('tenant_id', tenantId)
      .order('code', { ascending: true });

    if (error) throw error;

    // Fetch batch costs to calculate recipe formulation cost
    const { data: batches } = await supabase
      .from('material_batches')
      .select('material_id, cost_per_kg')
      .eq('tenant_id', tenantId)
      .gt('cost_per_kg', 0);

    const costMap: Record<string, number> = {};
    (batches || []).forEach((b: any) => {
      const cost = Number(b.cost_per_kg);
      if (cost > 0) costMap[b.material_id] = cost;
    });

    // Map to include latest active recipe and calculated formulation cost
    const enriched = products.map((p: any) => {
      const activeRecipe = (p.product_recipes || []).find((r: any) => r.is_active) || p.product_recipes?.[0] || null;
      let recipeCost = 0;
      if (activeRecipe?.product_recipe_items) {
        recipeCost = activeRecipe.product_recipe_items.reduce((sum: number, it: any) => {
          const cost = costMap[it.material_id] || 0;
          return sum + ((Number(it.percentage) || 0) / 100) * cost;
        }, 0);
      }
      return {
        ...p,
        recipe_cost_per_kg: Number(recipeCost.toFixed(2)),
        active_recipe: activeRecipe
          ? { ...activeRecipe, recipe_cost_per_kg: Number(recipeCost.toFixed(2)) }
          : null,
      };
    });

    return res.json({ success: true, products: enriched });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Create Product (Auto-generates PRD-XXXX code if not provided)
export const createProduct = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = req.user?.id;

    const schema = z.object({
      code: z.string().optional(),
      name: z.string().min(2),
      description: z.string().optional(),
      unit: z.enum(['kg', 'pcs', 'rolls']).default('kg'),
      standardWeightKg: z.number().positive().default(1.0),
      initialRecipe: z.object({
        notes: z.string().optional(),
        items: z.array(z.object({
          materialId: z.string().min(1),
          percentage: z.number().min(0).max(100),
          plannedKgPerKgOutput: z.number().positive(),
        })).min(1),
      }).optional(),
    });

    const body = schema.parse(req.body);
    const generatedCode = body.code ? body.code.toUpperCase() : `PRD-${Math.floor(Math.random() * 9000 + 1000)}`;

    if (!isSupabaseConfigured) {
      const newProductId = crypto.randomUUID();
      const newRecipeId = crypto.randomUUID();

      let initialRecipes: InMemRecipe[] = [];
      if (body.initialRecipe) {
        const recipeItems: InMemRecipeItem[] = body.initialRecipe.items.map((i) => {
          const mat = inMemMaterials.find((m) => m.id === i.materialId);
          return {
            id: crypto.randomUUID(),
            recipe_id: newRecipeId,
            material_id: i.materialId,
            percentage: i.percentage,
            planned_kg_per_kg_output: i.plannedKgPerKgOutput,
            materials: mat ? { id: mat.id, code: mat.code, name: mat.name, standard_unit: mat.standard_unit } : undefined,
          };
        });

        initialRecipes = [
          {
            id: newRecipeId,
            tenant_id: tenantId,
            product_id: newProductId,
            version: 1,
            is_active: true,
            notes: body.initialRecipe.notes || 'Initial product BOM formulation',
            created_by: userId,
            effective_date: new Date().toISOString(),
            product_recipe_items: recipeItems,
          },
        ];
      }

      const newProduct: InMemProduct = {
        id: newProductId,
        tenant_id: tenantId,
        code: generatedCode,
        name: body.name.trim(),
        description: body.description?.trim() || '',
        unit: body.unit,
        standard_weight_kg: body.standardWeightKg,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        product_recipes: initialRecipes,
      };

      inMemProducts.push(newProduct);
      return res.status(201).json({
        success: true,
        product: { ...newProduct, active_recipe: initialRecipes[0] || null },
      });
    }

    // Supabase mode:
    // 1. Create product
    const { data: product, error: prdError } = await supabase
      .from('products')
      .insert({
        tenant_id: tenantId,
        code: generatedCode,
        name: body.name.trim(),
        description: body.description,
        unit: body.unit,
        standard_weight_kg: body.standardWeightKg,
      })
      .select('*')
      .single();

    if (prdError) throw prdError;

    // 2. Create version 1 recipe if supplied
    if (body.initialRecipe) {
      const { data: recipe, error: recError } = await supabase
        .from('product_recipes')
        .insert({
          tenant_id: tenantId,
          product_id: product.id,
          version: 1,
          is_active: true,
          notes: body.initialRecipe.notes,
          created_by: userId,
        })
        .select('*')
        .single();

      if (recError) throw recError;

      const items = body.initialRecipe.items.map((item) => ({
        recipe_id: recipe.id,
        material_id: item.materialId,
        percentage: item.percentage,
        planned_kg_per_kg_output: item.plannedKgPerKgOutput,
      }));

      await supabase.from('product_recipe_items').insert(items);
    }

    return res.status(201).json({ success: true, product });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Update Product
export const updateProduct = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const schema = z.object({
      name: z.string().min(2).optional(),
      description: z.string().optional(),
      unit: z.enum(['kg', 'pcs', 'rolls']).optional(),
      standardWeightKg: z.number().positive().optional(),
      isActive: z.boolean().optional(),
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      const idx = inMemProducts.findIndex((p) => p.tenant_id === tenantId && p.id === id);
      if (idx === -1) {
        return res.status(404).json({ success: false, message: 'Product not found' });
      }

      inMemProducts[idx] = {
        ...inMemProducts[idx],
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.description !== undefined ? { description: body.description.trim() } : {}),
        ...(body.unit ? { unit: body.unit } : {}),
        ...(body.standardWeightKg !== undefined ? { standard_weight_kg: body.standardWeightKg } : {}),
        ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
        updated_at: new Date().toISOString(),
      };

      return res.json({ success: true, product: inMemProducts[idx] });
    }

    const updates: any = { updated_at: new Date().toISOString() };
    if (body.name) updates.name = body.name.trim();
    if (body.description !== undefined) updates.description = body.description;
    if (body.unit) updates.unit = body.unit;
    if (body.standardWeightKg !== undefined) updates.standard_weight_kg = body.standardWeightKg;
    if (body.isActive !== undefined) updates.is_active = body.isActive;

    const { data, error } = await supabase
      .from('products')
      .update(updates)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ success: true, product: data });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Delete Product
export const deleteProduct = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;

    if (!isSupabaseConfigured) {
      const initialLen = inMemProducts.length;
      inMemProducts = inMemProducts.filter((p) => !(p.tenant_id === tenantId && p.id === id));
      if (inMemProducts.length === initialLen) {
        return res.status(404).json({ success: false, message: 'Product not found' });
      }
      return res.json({ success: true, message: 'Product deleted successfully' });
    }

    // Delete child recipe items and recipes first if needed
    const { data: recipes } = await supabase
      .from('product_recipes')
      .select('id')
      .eq('product_id', id)
      .eq('tenant_id', tenantId);

    if (recipes && recipes.length > 0) {
      const recIds = recipes.map((r: any) => r.id);
      await supabase.from('product_recipe_items').delete().in('recipe_id', recIds);
      await supabase.from('product_recipes').delete().eq('product_id', id).eq('tenant_id', tenantId);
    }

    const { error } = await supabase
      .from('products')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) throw error;
    return res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Create a new version of a recipe (PRD-04: Versioning preserved)
export const addRecipeVersion = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = req.user?.id;
    const { productId } = req.params;

    const schema = z.object({
      notes: z.string().optional(),
      items: z.array(z.object({
        materialId: z.string().min(1),
        percentage: z.number().min(0).max(100),
        plannedKgPerKgOutput: z.number().positive(),
      })).min(1),
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      const product = inMemProducts.find((p) => p.tenant_id === tenantId && p.id === productId);
      if (!product) {
        return res.status(404).json({ success: false, message: 'Product not found' });
      }

      // Deactivate prior versions
      const currentRecipes = product.product_recipes || [];
      currentRecipes.forEach((r) => {
        r.is_active = false;
      });

      const nextVersion = currentRecipes.length + 1;
      const newRecId = crypto.randomUUID();

      const recipeItems: InMemRecipeItem[] = body.items.map((i) => {
        const mat = inMemMaterials.find((m) => m.id === i.materialId);
        return {
          id: crypto.randomUUID(),
          recipe_id: newRecId,
          material_id: i.materialId,
          percentage: i.percentage,
          planned_kg_per_kg_output: i.plannedKgPerKgOutput,
          materials: mat ? { id: mat.id, code: mat.code, name: mat.name, standard_unit: mat.standard_unit } : undefined,
        };
      });

      const newRecipe: InMemRecipe = {
        id: newRecId,
        tenant_id: tenantId,
        product_id: productId,
        version: nextVersion,
        is_active: true,
        notes: body.notes || `Recipe Version ${nextVersion}`,
        created_by: userId,
        effective_date: new Date().toISOString(),
        product_recipe_items: recipeItems,
      };

      currentRecipes.unshift(newRecipe);
      product.product_recipes = currentRecipes;

      return res.status(201).json({ success: true, recipe: newRecipe, version: nextVersion });
    }

    // Get max version
    const { data: existingRecipes } = await supabase
      .from('product_recipes')
      .select('version')
      .eq('product_id', productId)
      .eq('tenant_id', tenantId)
      .order('version', { ascending: false });

    const nextVersion = (existingRecipes?.[0]?.version || 0) + 1;

    // Deactivate prior versions
    await supabase
      .from('product_recipes')
      .update({ is_active: false })
      .eq('product_id', productId)
      .eq('tenant_id', tenantId);

    // Insert new version
    const { data: newRecipe, error: recError } = await supabase
      .from('product_recipes')
      .insert({
        tenant_id: tenantId,
        product_id: productId,
        version: nextVersion,
        is_active: true,
        notes: body.notes,
        created_by: userId,
      })
      .select('*')
      .single();

    if (recError) throw recError;

    const items = body.items.map((i) => ({
      recipe_id: newRecipe.id,
      material_id: i.materialId,
      percentage: i.percentage,
      planned_kg_per_kg_output: i.plannedKgPerKgOutput,
    }));

    await supabase.from('product_recipe_items').insert(items);

    return res.status(201).json({ success: true, recipe: newRecipe, version: nextVersion });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Calculate planned raw material requirements before production (PRD-05)
export const calculateRequirements = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { recipeId, quantityKg } = req.body;

    if (!recipeId || !quantityKg || quantityKg <= 0) {
      return res.status(400).json({ success: false, message: 'recipeId and positive quantityKg required' });
    }

    if (!isSupabaseConfigured) {
      let foundRecipe: InMemRecipe | null = null;
      for (const p of inMemProducts) {
        if (p.tenant_id === tenantId) {
          const r = (p.product_recipes || []).find((rec) => rec.id === recipeId);
          if (r) {
            foundRecipe = r;
            break;
          }
        }
      }

      if (!foundRecipe) {
        return res.status(404).json({ success: false, message: 'Recipe not found' });
      }

      const requirements = foundRecipe.product_recipe_items.map((item) => {
        const requiredKg = Number(quantityKg) * Number(item.planned_kg_per_kg_output);
        const availableBatches = inMemBatches.filter(
          (b) => b.tenant_id === tenantId && b.material_id === item.material_id && b.status === 'available' && b.remaining_quantity_kg > 0
        );
        const totalAvailable = availableBatches.reduce((acc, b) => acc + b.remaining_quantity_kg, 0);

        return {
          material_id: item.material_id,
          material_code: item.materials?.code || 'MAT-XXX',
          material_name: item.materials?.name || 'Raw Material',
          percentage: item.percentage,
          planned_kg_per_kg_output: item.planned_kg_per_kg_output,
          required_kg: requiredKg,
          available_stock_kg: totalAvailable,
          sufficient: totalAvailable >= requiredKg,
          suggested_batches: availableBatches,
        };
      });

      const allSufficient = requirements.every((r) => r.sufficient);

      return res.json({
        success: true,
        recipe_id: foundRecipe.id,
        planned_quantity_kg: quantityKg,
        all_sufficient: allSufficient,
        requirements,
      });
    }

    const { data: recipe, error: recError } = await supabase
      .from('product_recipes')
      .select(`
        id, version, product_id,
        product_recipe_items (
          material_id, percentage, planned_kg_per_kg_output,
          materials (id, code, name, standard_unit)
        )
      `)
      .eq('id', recipeId)
      .eq('tenant_id', tenantId)
      .single();

    if (recError || !recipe) {
      return res.status(404).json({ success: false, message: 'Recipe not found' });
    }

    // Check available batches for each material
    const requirements = await Promise.all(
      (recipe.product_recipe_items || []).map(async (item: any) => {
        const requiredKg = Number(quantityKg) * Number(item.planned_kg_per_kg_output);
        const { data: batches } = await supabase
          .from('material_batches')
          .select('id, batch_number, remaining_quantity_kg, receipt_date')
          .eq('material_id', item.material_id)
          .eq('tenant_id', tenantId)
          .eq('status', 'available')
          .gt('remaining_quantity_kg', 0)
          .order('receipt_date', { ascending: true }); // FIFO order

        const totalAvailable = (batches || []).reduce((acc: number, b: any) => acc + Number(b.remaining_quantity_kg), 0);

        return {
          material_id: item.material_id,
          material_code: item.materials?.code,
          material_name: item.materials?.name,
          percentage: item.percentage,
          planned_kg_per_kg_output: item.planned_kg_per_kg_output,
          required_kg: requiredKg,
          available_stock_kg: totalAvailable,
          sufficient: totalAvailable >= requiredKg,
          suggested_batches: batches || [],
        };
      })
    );

    const allSufficient = requirements.every((r) => r.sufficient);

    return res.json({
      success: true,
      recipe_id: recipe.id,
      planned_quantity_kg: quantityKg,
      all_sufficient: allSufficient,
      requirements,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 1-Click Seed Standard Products & Packaging Recipes (PRD-01)
export const seedDefaultProducts = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = req.user?.id;

    // Get available materials in this tenant to link recipes
    let availableMaterials: any[] = [];
    if (!isSupabaseConfigured) {
      availableMaterials = inMemMaterials.filter((m) => m.tenant_id === tenantId);
    } else {
      const { data: mats } = await supabase
        .from('materials')
        .select('id, code, name')
        .eq('tenant_id', tenantId);
      availableMaterials = mats || [];
    }

    const defaultDefs = [
      {
        code: `PRD-${Math.floor(Math.random() * 9000 + 1000)}`,
        name: '3-Layer Milk Pouch Packaging Film (50 Micron)',
        description: 'Co-extruded high-barrier film for liquid dairy packaging with excellent puncture resistance.',
        unit: 'kg',
        standardWeightKg: 1.0,
        ratios: [
          { percent: 60, perKg: 0.60 },
          { percent: 30, perKg: 0.30 },
          { percent: 10, perKg: 0.10 },
        ],
      },
      {
        code: `PRD-${Math.floor(Math.random() * 9000 + 1000)}`,
        name: 'Heavy-Duty Industrial Polymer Liners (100 Micron)',
        description: 'Gusseted liners for chemical, fertilizer, and agricultural batch packaging bags.',
        unit: 'kg',
        standardWeightKg: 1.0,
        ratios: [
          { percent: 80, perKg: 0.80 },
          { percent: 20, perKg: 0.20 },
        ],
      },
      {
        code: `PRD-${Math.floor(Math.random() * 9000 + 1000)}`,
        name: 'Tamper-Evident Courier & Mailing Security Bags',
        description: 'Multi-layer security mailer bags with hot-melt permanent adhesive closure.',
        unit: 'kg',
        standardWeightKg: 1.0,
        ratios: [
          { percent: 70, perKg: 0.70 },
          { percent: 25, perKg: 0.25 },
          { percent: 5, perKg: 0.05 },
        ],
      },
    ];

    if (!isSupabaseConfigured) {
      const created: InMemProduct[] = [];
      for (const def of defaultDefs) {
        const prodId = crypto.randomUUID();
        const recId = crypto.randomUUID();

        // Build recipe items linking available materials
        const items: InMemRecipeItem[] = def.ratios.map((ratio, idx) => {
          const mat = availableMaterials[idx % Math.max(availableMaterials.length, 1)];
          return {
            id: crypto.randomUUID(),
            recipe_id: recId,
            material_id: mat?.id || `mat-${idx + 1}`,
            percentage: ratio.percent,
            planned_kg_per_kg_output: ratio.perKg,
            materials: mat ? { id: mat.id, code: mat.code, name: mat.name, standard_unit: 'kg' } : undefined,
          };
        });

        const newRec: InMemRecipe = {
          id: recId,
          tenant_id: tenantId,
          product_id: prodId,
          version: 1,
          is_active: true,
          notes: 'Standard certified extrusion recipe (V1)',
          created_by: userId,
          effective_date: new Date().toISOString(),
          product_recipe_items: items,
        };

        const prod: InMemProduct = {
          id: prodId,
          tenant_id: tenantId,
          code: def.code,
          name: def.name,
          description: def.description,
          unit: def.unit,
          standard_weight_kg: def.standardWeightKg,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          product_recipes: [newRec],
        };

        inMemProducts.push(prod);
        created.push(prod);
      }

      return res.status(201).json({
        success: true,
        message: 'Configured 3 standard packaging products with recipes!',
        products: created,
      });
    }

    // Supabase mode:
    const seeded = [];
    for (const def of defaultDefs) {
      const { data: prod, error: prdErr } = await supabase
        .from('products')
        .insert({
          tenant_id: tenantId,
          code: def.code,
          name: def.name,
          description: def.description,
          unit: def.unit,
          standard_weight_kg: def.standardWeightKg,
        })
        .select('*')
        .single();

      if (prdErr) continue;

      // Create recipe v1
      const { data: rec, error: recErr } = await supabase
        .from('product_recipes')
        .insert({
          tenant_id: tenantId,
          product_id: prod.id,
          version: 1,
          is_active: true,
          notes: 'Standard certified extrusion recipe (V1)',
          created_by: userId,
        })
        .select('*')
        .single();

      if (!recErr && availableMaterials.length > 0) {
        const items = def.ratios.map((ratio, idx) => {
          const mat = availableMaterials[idx % availableMaterials.length];
          return {
            recipe_id: rec.id,
            material_id: mat.id,
            percentage: ratio.percent,
            planned_kg_per_kg_output: ratio.perKg,
          };
        });
        await supabase.from('product_recipe_items').insert(items);
      }

      seeded.push(prod);
    }

    return res.status(201).json({
      success: true,
      message: `Configured ${seeded.length} standard packaging products with versioned recipes!`,
      products: seeded,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
