<?php

namespace Database\Seeders;

use App\Models\Category;
use App\Models\Product;
use Illuminate\Database\Seeder;
use Illuminate\Support\Str;

class ProductCatalogSeeder extends Seeder
{
    // Transcribed and translated from the store's handwritten price
    // boards (Cebuano terms translated — Kabelya to Rebar, Lababo to
    // Wash Basin, Trapal to Tarpaulin, Baga/Nipis to Thick/Thin, and
    // 'Bowl' clarified to Toilet Bowl since that's what it means here).
    //
    // cost_price is intentionally left null for every row — the boards
    // are customer-facing SELLING prices, there's no supplier cost data
    // anywhere in the photos, and guessing one would be worse than a
    // visible gap. reorder_level defaults to 10 as a placeholder, not a
    // real threshold — nothing in the source data indicates real reorder
    // points, that needs the owners' judgment based on actual turnover.
    //
    // Nails are priced per kilogram (unit='kg') using the board's 1kg
    // rate. The existing billing math (unit_price x quantity) already
    // handles a 0.25kg sale correctly with no new code — see the reply
    // for why this was chosen over three separate SKUs per weight tier.
    //
    // id is set explicitly here with Str::uuid() rather than left for
    // HasUuid's creating() hook to fill in. Something in this environment
    // is preventing that hook from firing (still unconfirmed why), so
    // this seeder no longer depends on it working.
    //
    // firstOrCreate on sku: safe to re-run, won't duplicate if some of
    // these already exist.
    public function run(): void
    {
        $categories = [];
        foreach ([
            'Cement & Concrete',
            'Rebar & Steel Bars',
            'Roofing Sheets',
            'Plywood & Boards',
            'Steel Tubing & Framing',
            'GI Pipes',
            'PVC Pipes & Fittings',
            'Nails & Fasteners',
            'Wire, Mesh & Ties',
            'Bathroom Fixtures',
            'Adhesives & Finishing',
            'Doors & Tarpaulin',
        ] as $name) {
            $categories[$name] = Category::firstOrCreate(
                ['name' => $name],
                ['id' => (string) Str::uuid(), 'is_active' => true]
            );
        }

        $products = [

            // Cement & Concrete
            ['sku' => 'CEM-001', 'name' => 'Union Cement', 'category' => 'Cement & Concrete', 'unit' => 'bag', 'unit_price' => 235.00],
            ['sku' => 'CEM-002', 'name' => 'Premium Cement', 'category' => 'Cement & Concrete', 'unit' => 'bag', 'unit_price' => 255.00],
            ['sku' => 'CEM-003', 'name' => 'Holcim Cement', 'category' => 'Cement & Concrete', 'unit' => 'bag', 'unit_price' => 250.00],
            ['sku' => 'CEM-004', 'name' => 'Red Cement (U.S.)', 'category' => 'Cement & Concrete', 'unit' => 'bag', 'unit_price' => 117.00],

            // Rebar & Steel Bars
            ['sku' => 'BAR-001', 'name' => 'Rebar 7mm', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 80.00], // was 'Kabelya 7mm (1.2)' — 1.2 is kg/pc
            ['sku' => 'BAR-002', 'name' => 'Rebar 8mm', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 100.00], // was 'Kabelya 8mm (1.7)' — 1.7 is kg/pc
            ['sku' => 'BAR-003', 'name' => 'Rebar 9mm', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 120.00], // was 'Kabelya 9mm (2.2)' — 2.2 is kg/pc
            ['sku' => 'BAR-004', 'name' => 'Rebar 10mm', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 198.00],
            ['sku' => 'BAR-005', 'name' => 'Rebar 12mm', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 260.00],
            ['sku' => 'BAR-006', 'name' => 'Rebar 16mm', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 465.00],
            ['sku' => 'BAR-007', 'name' => 'Plain Bar 8mm', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 250.00],
            ['sku' => 'BAR-008', 'name' => 'Plain Bar 9mm', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 270.00],
            ['sku' => 'BAR-009', 'name' => 'Plain Bar 10mm', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 310.00],
            ['sku' => 'BAR-010', 'name' => 'Plain Bar 12mm', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 430.00],
            ['sku' => 'BAR-011', 'name' => 'Plain Bar 16mm', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 520.00],
            ['sku' => 'BAR-012', 'name' => 'Square Bar 8mm (Blue)', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 125.00],
            ['sku' => 'BAR-013', 'name' => 'Square Bar 9mm (Green)', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 150.00],
            ['sku' => 'BAR-014', 'name' => 'Square Bar 10mm (Orange)', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 185.00],
            ['sku' => 'BAR-015', 'name' => 'Square Bar 12mm (White)', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 235.00],
            ['sku' => 'BAR-016', 'name' => 'Flat Bar 3/16" x 3/4"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 195.00],
            ['sku' => 'BAR-017', 'name' => 'Flat Bar 5mm x 3/4"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 351.00],
            ['sku' => 'BAR-018', 'name' => 'Flat Bar 3/16" x 1"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 260.00],
            ['sku' => 'BAR-019', 'name' => 'Flat Bar 1/4" x 1"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 338.00],
            ['sku' => 'BAR-020', 'name' => 'Flat Bar 5mm x 1"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 500.00],
            ['sku' => 'BAR-021', 'name' => 'Flat Bar 3/16" x 1-1/2"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 400.00],
            ['sku' => 'BAR-022', 'name' => 'Flat Bar 1/4" x 1-1/2"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 507.00],
            ['sku' => 'BAR-023', 'name' => 'Flat Bar 5mm x 1-1/2"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 676.00],
            ['sku' => 'BAR-024', 'name' => 'Flat Bar 3/16" x 2"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 575.00],
            ['sku' => 'BAR-025', 'name' => 'Flat Bar 1/4" x 2"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 712.00],
            ['sku' => 'BAR-026', 'name' => 'Flat Bar 5mm x 2"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 1230.00],
            ['sku' => 'BAR-027', 'name' => 'Flat Bar 5mm x 3"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 1339.00],
            ['sku' => 'BAR-028', 'name' => 'Angle Bar 3/16" x 1"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 470.00],
            ['sku' => 'BAR-029', 'name' => 'Angle Bar 1/4" x 1" (Green)', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 530.00],
            ['sku' => 'BAR-030', 'name' => 'Angle Bar 5mm x 1"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 650.00],
            ['sku' => 'BAR-031', 'name' => 'Angle Bar 1/4" x 1-1/2"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 745.00],
            ['sku' => 'BAR-032', 'name' => 'Angle Bar 5mm x 1-1/2"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 1010.00],
            ['sku' => 'BAR-033', 'name' => 'Angle Bar 3/16" x 1-1/2"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 590.00],
            ['sku' => 'BAR-034', 'name' => 'Angle Bar 1/4" x 2"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 930.00],
            ['sku' => 'BAR-035', 'name' => 'Angle Bar 3/16" x 2"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 745.00],
            ['sku' => 'BAR-036', 'name' => 'Angle Bar 5mm x 2"', 'category' => 'Rebar & Steel Bars', 'unit' => 'pc', 'unit_price' => 1240.00],

            // Roofing Sheets
            ['sku' => 'ROOF-001', 'name' => 'Superlume Ultra #8', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 220.00],
            ['sku' => 'ROOF-002', 'name' => 'Superlume Ultra #10', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 265.00],
            ['sku' => 'ROOF-003', 'name' => 'Superlume Ultra #12', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 320.00],
            ['sku' => 'ROOF-004', 'name' => 'Superlume Excel #8', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 246.00],
            ['sku' => 'ROOF-005', 'name' => 'Superlume Excel #10', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 315.00],
            ['sku' => 'ROOF-006', 'name' => 'Superlume Excel #12', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 378.00],
            ['sku' => 'ROOF-007', 'name' => 'Ninjalume #8', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 265.00],
            ['sku' => 'ROOF-008', 'name' => 'Ninjalume #10', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 330.00],
            ['sku' => 'ROOF-009', 'name' => 'Ninjalume #12', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 390.00],
            ['sku' => 'ROOF-010', 'name' => 'Ninjalume #14', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 485.00],
            ['sku' => 'ROOF-011', 'name' => 'Tamaraw #8', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 212.00],
            ['sku' => 'ROOF-012', 'name' => 'Tamaraw #10', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 258.00],
            ['sku' => 'ROOF-013', 'name' => 'Tamaraw #12', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 305.00],
            ['sku' => 'ROOF-014', 'name' => 'Plain Sheet (Sumo)', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 206.00],
            ['sku' => 'ROOF-015', 'name' => 'Plain Sheet (Ultra)', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 230.00],
            ['sku' => 'ROOF-016', 'name' => 'Plain Sheet (Excel)', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 245.00],
            ['sku' => 'ROOF-017', 'name' => 'Plain Sheet (Ninja .2)', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 270.00],
            ['sku' => 'ROOF-018', 'name' => 'Plain Sheet (Ninja .3)', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 345.00],
            ['sku' => 'ROOF-019', 'name' => 'Plain Sheet (Ninja .4)', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 407.00],
            ['sku' => 'ROOF-020', 'name' => 'Plain Sheet, Colored (Red/Blue)', 'category' => 'Roofing Sheets', 'unit' => 'sheet', 'unit_price' => 390.00],
            ['sku' => 'ROOF-021', 'name' => 'Rib Type Roofing #8', 'category' => 'Roofing Sheets', 'unit' => 'ft', 'unit_price' => 448.00], // priced per foot on the sheet, not per piece
            ['sku' => 'ROOF-022', 'name' => 'Rib Type Roofing #10', 'category' => 'Roofing Sheets', 'unit' => 'ft', 'unit_price' => 560.00], // priced per foot on the sheet, not per piece
            ['sku' => 'ROOF-023', 'name' => 'Rib Type Roofing #12', 'category' => 'Roofing Sheets', 'unit' => 'ft', 'unit_price' => 672.00], // priced per foot on the sheet, not per piece
            ['sku' => 'ROOF-024', 'name' => 'Rib Type Roofing #14', 'category' => 'Roofing Sheets', 'unit' => 'ft', 'unit_price' => 785.00], // priced per foot on the sheet, not per piece

            // Plywood & Boards
            ['sku' => 'PLY-001', 'name' => 'Ordinary Plywood 1/4" (Local)', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 465.00],
            ['sku' => 'PLY-002', 'name' => 'Marine Plywood 1/4" (Local)', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 485.00],
            ['sku' => 'PLY-003', 'name' => 'Ordinary Plywood 1/2" (Local)', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 785.00],
            ['sku' => 'PLY-004', 'name' => 'Marine Plywood 1/2" (Local)', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 988.00],
            ['sku' => 'PLY-005', 'name' => 'Marine Plywood 3/4" (Local)', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 1688.00],
            ['sku' => 'PLY-006', 'name' => 'Ordinary Plywood 3/4" (Local)', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 1350.00],
            ['sku' => 'PLY-007', 'name' => 'Ordinary Plywood 1/4" (China)', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 355.00],
            ['sku' => 'PLY-008', 'name' => 'Ordinary Plywood 1/2" (China)', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 700.00],
            ['sku' => 'PLY-009', 'name' => 'Ordinary Plywood 3/4" (China)', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 1080.00],
            ['sku' => 'PLY-010', 'name' => 'Marine Plywood 1/4" (China)', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 375.00],
            ['sku' => 'PLY-011', 'name' => 'Marine Plywood 1/2" (China)', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 770.00],
            ['sku' => 'PLY-012', 'name' => 'Marine Plywood 3/4" (China)', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 1140.00],
            ['sku' => 'PLY-013', 'name' => 'Sta. Clara Plywood 1/4"', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 975.00],
            ['sku' => 'PLY-014', 'name' => 'Hardiflex Ever Board 3/16"', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 400.00],
            ['sku' => 'PLY-015', 'name' => 'Hardiflex Ever Board 1/4"', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 490.00],
            ['sku' => 'PLY-016', 'name' => 'Hardiflex Gardner 3/16"', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 390.00],
            ['sku' => 'PLY-017', 'name' => 'Hardiflex Gardner 1/4"', 'category' => 'Plywood & Boards', 'unit' => 'sheet', 'unit_price' => 510.00],

            // Steel Tubing & Framing
            ['sku' => 'STL-001', 'name' => 'Square Tube 2x2x1.2mm', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 650.00],
            ['sku' => 'STL-002', 'name' => 'Square Tube 2x2x1.5mm (Black Iron)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 740.00],
            ['sku' => 'STL-003', 'name' => 'Square Tube 2x2x1.5mm (Galvanized)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 905.00],
            ['sku' => 'STL-004', 'name' => 'Rectangular Tube 2x3x1.5mm (Black Iron)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 985.00],
            ['sku' => 'STL-005', 'name' => 'Rectangular Tube 2x3x1.5mm (Galvanized)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 1030.00],
            ['sku' => 'STL-006', 'name' => 'GI Rectangular Tube 1x3x1.5mm', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 850.00],
            ['sku' => 'STL-007', 'name' => 'GI Square Tube 1x1x1.5mm (Galvanized)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 510.00],
            ['sku' => 'STL-008', 'name' => 'Black Iron Square Tube 1x1x1.5mm', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 445.00],
            ['sku' => 'STL-009', 'name' => 'Rectangular Tube 2x3x1.2mm (Yellow)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 565.00],
            ['sku' => 'STL-010', 'name' => 'GI Rectangular Tube 1x2x1.5mm (Galvanized)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 700.00],
            ['sku' => 'STL-011', 'name' => 'Rectangular Tube 2x4x1.5mm (Galvanized)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 1280.00],
            ['sku' => 'STL-012', 'name' => 'Rectangular Tube 2x4x1.5mm (Black Iron)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 1075.00],
            ['sku' => 'STL-013', 'name' => 'Rectangular Tube 1x2x1.5mm (Black Iron)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 650.00],
            ['sku' => 'STL-014', 'name' => 'Rectangular Tube 1x2x1.2mm', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 535.00],
            ['sku' => 'STL-015', 'name' => 'C-Purlins 2x3x0.8mm', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 435.00],
            ['sku' => 'STL-016', 'name' => 'C-Purlins 2x3x1.5mm (Silver)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 700.00],
            ['sku' => 'STL-017', 'name' => 'C-Purlins 2x3x1.5mm (Galvanized)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 730.00],
            ['sku' => 'STL-018', 'name' => 'C-Purlins 2x4x1.5mm (Silver)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 800.00],
            ['sku' => 'STL-019', 'name' => 'C-Purlins 2x4x1.5mm (Galvanized)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 845.00],
            ['sku' => 'STL-020', 'name' => 'C-Purlins 2x6x1.5mm', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 980.00],
            ['sku' => 'STL-021', 'name' => 'Double Furring 1x2 (.3mm)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 190.00],
            ['sku' => 'STL-022', 'name' => 'Double Furring 1x2 (.4mm)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 250.00],
            ['sku' => 'STL-023', 'name' => 'Single Furring (.4mm)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 182.00],
            ['sku' => 'STL-024', 'name' => 'Wall Angle 1x1 (.4mm)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 125.00],
            ['sku' => 'STL-025', 'name' => 'C-Channel (.4mm)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 225.00],
            ['sku' => 'STL-026', 'name' => 'Metal Studs (.4mm)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 255.00],
            ['sku' => 'STL-027', 'name' => 'Track 2x3 (.3mm)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 175.00],
            ['sku' => 'STL-028', 'name' => 'Track (variant, size unclear in photo)', 'category' => 'Steel Tubing & Framing', 'unit' => 'pc', 'unit_price' => 238.00], // bottom of the page was cut off — confirm the exact size before using this row

            // GI Pipes
            ['sku' => 'GIP-001', 'name' => 'GI Pipe 1/2" (SD-20) Local (Black)', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 515.00],
            ['sku' => 'GIP-002', 'name' => 'GI Pipe 1/2" (SD-40) Local (Red)', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 550.00],
            ['sku' => 'GIP-003', 'name' => 'GI Pipe 3/4" (SD-20) Local', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 535.00],
            ['sku' => 'GIP-004', 'name' => 'GI Pipe 3/4" (SD-40) Local', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 600.00],
            ['sku' => 'GIP-005', 'name' => 'GI Pipe 1" (SD-20) Local', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 720.00],
            ['sku' => 'GIP-006', 'name' => 'GI Pipe 1" (SD-40) Local', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 897.00],
            ['sku' => 'GIP-007', 'name' => 'GI Pipe 1-1/4" (SD-20) China', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 600.00],
            ['sku' => 'GIP-008', 'name' => 'GI Pipe 1-1/4" (SD-40) Local', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 1338.00],
            ['sku' => 'GIP-009', 'name' => 'GI Pipe 1-1/2" (SD-20) China', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 730.00],
            ['sku' => 'GIP-010', 'name' => 'GI Pipe 1-1/2" (SD-20) Local', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 1270.00],
            ['sku' => 'GIP-011', 'name' => 'GI Pipe 1-1/2" (SD-40) Local', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 1690.00],
            ['sku' => 'GIP-012', 'name' => 'GI Pipe 2" (SD-20) Local, Light Gauge', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 1716.00], // labeled 'Fence tube' on the sheet
            ['sku' => 'GIP-013', 'name' => 'GI Pipe 2" (SD-40) Local', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 2210.00],
            ['sku' => 'GIP-014', 'name' => 'GI Pipe 2-1/2" (SD-20) Local', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 2630.00],
            ['sku' => 'GIP-015', 'name' => 'GI Pipe 3" (SD-20) Economy (Red)', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 1365.00],
            ['sku' => 'GIP-016', 'name' => 'GI Pipe 3" (SD-20) Local', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 3500.00],
            ['sku' => 'GIP-017', 'name' => 'GI Pipe 3" (SD-40) Local', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 4938.00],
            ['sku' => 'GIP-018', 'name' => 'GI Pipe 4" (SD-20) Economy (Black)', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 1750.00],
            ['sku' => 'GIP-019', 'name' => 'GI Pipe 4" (SD-20) (Red)', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 2000.00],
            ['sku' => 'GIP-020', 'name' => 'GI Pipe 4" (SD-40) Local', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 5330.00],
            ['sku' => 'GIP-021', 'name' => 'GI Pipe 1/2" (SD-20) Samurai (White)', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 355.00], // fence tube variant
            ['sku' => 'GIP-022', 'name' => 'GI Pipe 1/2" (SD-40) Samurai (Violet)', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 460.00],
            ['sku' => 'GIP-023', 'name' => 'GI Pipe 3/4" (SD-20) Deluxe (White)', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 450.00], // fence tube variant
            ['sku' => 'GIP-024', 'name' => 'GI Pipe 3/4" (SD-40) Samurai (Violet)', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 490.00],
            ['sku' => 'GIP-025', 'name' => 'GI Pipe 1" (SD-20) Samurai (White)', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 515.00],
            ['sku' => 'GIP-026', 'name' => 'GI Pipe 1" (SD-40) Samurai (Violet)', 'category' => 'GI Pipes', 'unit' => 'pc', 'unit_price' => 570.00],

            // PVC Pipes & Fittings
            ['sku' => 'PVC-001', 'name' => 'PVC Electrical Pipe 1/2" (Thick), Orange', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 117.00], // was 'Baga' = thick-walled
            ['sku' => 'PVC-002', 'name' => 'PVC Electrical Pipe 3/4", Orange', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 156.00], // digit partly covered in the photo — please confirm 156
            ['sku' => 'PVC-003', 'name' => 'PVC Pipe 1/2" (Thick), Blue', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 100.00],
            ['sku' => 'PVC-004', 'name' => 'PVC Pipe 1/2" (Thin), Blue', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 68.00], // was 'Nipis' = thin-walled
            ['sku' => 'PVC-005', 'name' => 'PVC Pipe 3/4"', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 120.00],
            ['sku' => 'PVC-006', 'name' => 'PVC Pipe 1"', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 180.00],
            ['sku' => 'PVC-007', 'name' => 'PVC Pipe 1-1/4"', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 190.00],
            ['sku' => 'PVC-008', 'name' => 'PVC Pipe 1-1/2"', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 275.00],
            ['sku' => 'PVC-009', 'name' => 'PVC Pipe 2" (Blue)', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 445.00],
            ['sku' => 'PVC-010', 'name' => 'PVC Pipe 2" (Thick), Orange', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 332.00],
            ['sku' => 'PVC-011', 'name' => 'PVC Pipe 2" (Thin), Orange', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 195.00],
            ['sku' => 'PVC-012', 'name' => 'PVC Pipe 3" (Thick), Orange', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 663.00],
            ['sku' => 'PVC-013', 'name' => 'PVC Pipe 3" (Thin), Orange', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 260.00],
            ['sku' => 'PVC-014', 'name' => 'PVC Pipe 4" (Thick), Orange', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 858.00],
            ['sku' => 'PVC-015', 'name' => 'PVC Pipe 4" (Thin), Orange', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 480.00],
            ['sku' => 'PVC-016', 'name' => 'PE Coupling 1/2"', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 100.00],
            ['sku' => 'PVC-017', 'name' => 'PE Tee 1/2"', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 130.00],
            ['sku' => 'PVC-018', 'name' => 'PE Elbow 1/2"', 'category' => 'PVC Pipes & Fittings', 'unit' => 'pc', 'unit_price' => 130.00],

            // Nails & Fasteners
            ['sku' => 'NAIL-001', 'name' => 'CWN #1', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 68.00],
            ['sku' => 'NAIL-002', 'name' => 'CWN #1-1/2', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 68.00],
            ['sku' => 'NAIL-003', 'name' => 'CWN #2', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 68.00],
            ['sku' => 'NAIL-004', 'name' => 'CWN #2-1/2', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 68.00],
            ['sku' => 'NAIL-005', 'name' => 'CWN #3', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 62.00],
            ['sku' => 'NAIL-006', 'name' => 'CWN #4', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 62.00],
            ['sku' => 'NAIL-007', 'name' => 'CWN #5', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 62.00],
            ['sku' => 'NAIL-008', 'name' => 'Concrete Nails #2', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 95.00],
            ['sku' => 'NAIL-009', 'name' => 'Concrete Nails #2-1/2', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 95.00],
            ['sku' => 'NAIL-010', 'name' => 'Concrete Nails #3', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 95.00],
            ['sku' => 'NAIL-011', 'name' => 'Concrete Nails #4', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 95.00],
            ['sku' => 'NAIL-012', 'name' => 'Slim Concrete Nails #1', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 377.00],
            ['sku' => 'NAIL-013', 'name' => 'Slim Concrete Nails #1-1/2', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 345.00],
            ['sku' => 'NAIL-014', 'name' => 'Finishing Nails #1', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 78.00],
            ['sku' => 'NAIL-015', 'name' => 'Finishing Nails #1-1/2', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 78.00],
            ['sku' => 'NAIL-016', 'name' => 'Finishing Nails #2', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 78.00],
            ['sku' => 'NAIL-017', 'name' => 'Finishing Nails #2-1/2', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 78.00],
            ['sku' => 'NAIL-018', 'name' => 'Hardi Nails', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 117.00],
            ['sku' => 'NAIL-019', 'name' => 'Flat Head Nails', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 125.00],
            ['sku' => 'NAIL-020', 'name' => 'Umbrella Nails #2', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 85.00],
            ['sku' => 'NAIL-021', 'name' => 'Umbrella Nails #2-1/2', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 85.00],
            ['sku' => 'NAIL-022', 'name' => 'Copper Nails #1', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 1380.00],
            ['sku' => 'NAIL-023', 'name' => 'Copper Nails #1-1/2', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 1380.00],
            ['sku' => 'NAIL-024', 'name' => 'Copper Nails #2', 'category' => 'Nails & Fasteners', 'unit' => 'kg', 'unit_price' => 1380.00],

            // Wire, Mesh & Ties
            ['sku' => 'WIRE-001', 'name' => 'Tie Wire #16', 'category' => 'Wire, Mesh & Ties', 'unit' => 'roll', 'unit_price' => 80.00], // unit assumed — confirm if this is per roll or per kg
            ['sku' => 'WIRE-002', 'name' => 'W-Clip', 'category' => 'Wire, Mesh & Ties', 'unit' => 'pc', 'unit_price' => 10.00],
            ['sku' => 'WIRE-003', 'name' => 'Steel Matting, Ordinary #8', 'category' => 'Wire, Mesh & Ties', 'unit' => 'roll', 'unit_price' => 600.00],
            ['sku' => 'WIRE-004', 'name' => 'Steel Matting, Galvanized #8', 'category' => 'Wire, Mesh & Ties', 'unit' => 'roll', 'unit_price' => 700.00],

            // Bathroom Fixtures
            ['sku' => 'BATH-001', 'name' => 'Wash Basin, Stainless (Small)', 'category' => 'Bathroom Fixtures', 'unit' => 'pc', 'unit_price' => 900.00], // was 'Lababo'
            ['sku' => 'BATH-002', 'name' => 'Wash Basin, Ordinary (Small)', 'category' => 'Bathroom Fixtures', 'unit' => 'pc', 'unit_price' => 280.00], // was 'Lababo'
            ['sku' => 'BATH-003', 'name' => 'Toilet Bowl, Sub-Standard', 'category' => 'Bathroom Fixtures', 'unit' => 'pc', 'unit_price' => 900.00],
            ['sku' => 'BATH-004', 'name' => 'Toilet Bowl, Cement', 'category' => 'Bathroom Fixtures', 'unit' => 'pc', 'unit_price' => 300.00],
            ['sku' => 'BATH-005', 'name' => 'Toilet Bowl, Porcelain (Standard)', 'category' => 'Bathroom Fixtures', 'unit' => 'pc', 'unit_price' => 1170.00],

            // Adhesives & Finishing
            ['sku' => 'ADH-001', 'name' => 'Skim Coat', 'category' => 'Adhesives & Finishing', 'unit' => 'bag', 'unit_price' => 560.00],
            ['sku' => 'ADH-002', 'name' => 'ABC Tile Adhesive', 'category' => 'Adhesives & Finishing', 'unit' => 'bag', 'unit_price' => 420.00],
            ['sku' => 'ADH-003', 'name' => 'Island Adhesive', 'category' => 'Adhesives & Finishing', 'unit' => 'bag', 'unit_price' => 430.00],
            ['sku' => 'ADH-004', 'name' => 'Styrofoam Board #8, White', 'category' => 'Adhesives & Finishing', 'unit' => 'pc', 'unit_price' => 145.00],
            ['sku' => 'ADH-005', 'name' => 'Styrofoam Board B, White', 'category' => 'Adhesives & Finishing', 'unit' => 'pc', 'unit_price' => 170.00], // the size code read as 'B' — please confirm, may be a number

            // Doors & Tarpaulin
            ['sku' => 'DOOR-001', 'name' => 'PVC Door 60x210', 'category' => 'Doors & Tarpaulin', 'unit' => 'pc', 'unit_price' => 12500.00],
            ['sku' => 'DOOR-002', 'name' => 'Tarpaulin, Small', 'category' => 'Doors & Tarpaulin', 'unit' => 'roll', 'unit_price' => 3500.00], // was 'Trapal'
            ['sku' => 'DOOR-003', 'name' => 'Tarpaulin, Large', 'category' => 'Doors & Tarpaulin', 'unit' => 'roll', 'unit_price' => 4300.00], // was 'Trapal'
        ];

        foreach ($products as $p) {
            Product::firstOrCreate(
                ['sku' => $p['sku']],
                [
                    'id' => (string) Str::uuid(),
                    'name' => $p['name'],
                    'category_id' => $categories[$p['category']]->id,
                    'unit' => $p['unit'],
                    'unit_price' => $p['unit_price'],
                    'cost_price' => null,
                    'reorder_level' => 10,
                    'is_active' => true,
                ]
            );
        }
    }
}
