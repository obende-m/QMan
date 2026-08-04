---
name: QMan Clinical Flow
colors:
  surface: '#f7f9fb'
  surface-dim: '#d8dadc'
  surface-bright: '#f7f9fb'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f4f6'
  surface-container: '#eceef0'
  surface-container-high: '#e6e8ea'
  surface-container-highest: '#e0e3e5'
  on-surface: '#191c1e'
  on-surface-variant: '#434656'
  inverse-surface: '#2d3133'
  inverse-on-surface: '#eff1f3'
  outline: '#737688'
  outline-variant: '#c3c5d9'
  surface-tint: '#004ced'
  primary: '#003ec7'
  on-primary: '#ffffff'
  primary-container: '#0052ff'
  on-primary-container: '#dfe3ff'
  inverse-primary: '#b7c4ff'
  secondary: '#505f76'
  on-secondary: '#ffffff'
  secondary-container: '#d0e1fb'
  on-secondary-container: '#54647a'
  tertiary: '#005a3c'
  on-tertiary: '#ffffff'
  tertiary-container: '#007550'
  on-tertiary-container: '#72fec0'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dde1ff'
  primary-fixed-dim: '#b7c4ff'
  on-primary-fixed: '#001452'
  on-primary-fixed-variant: '#0038b6'
  secondary-fixed: '#d3e4fe'
  secondary-fixed-dim: '#b7c8e1'
  on-secondary-fixed: '#0b1c30'
  on-secondary-fixed-variant: '#38485d'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#f7f9fb'
  on-background: '#191c1e'
  surface-variant: '#e0e3e5'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  title-md:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 20px
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 24px
  margin: 32px
  container-max: 1440px
  sidebar-width: 260px
---

## Brand & Style
The design system is engineered to transform high-stress medical environments into spaces of organized calm. It moves away from the sterile, legacy aesthetics of traditional hospital software toward a **Modern Enterprise** aesthetic characterized by precision, intentional whitespace, and a high-performance "Pro" feel similar to top-tier engineering tools.

The visual language balances **Minimalism** with **Tonal Layering**. It prioritizes information density without clutter, using subtle depth to separate different functional areas like patient queues and diagnostic timelines. The emotional goal is to project absolute reliability and speed—reducing cognitive load for healthcare professionals through a clear, systematic interface.

## Colors
This design system utilizes a refined palette that communicates clinical authority through modern tech-centric hues.

- **Primary (Professional Blue):** A vibrant, high-contrast blue used for primary actions and active states. It signals confidence and digital precision.
- **Secondary (Slate Gray):** Used for iconography, secondary text, and borders to maintain a neutral, grounded feel.
- **Tertiary (Soft Emerald):** Specifically reserved for "Completed," "Healthy," or "Discharged" states, providing a calming visual reinforcement.
- **Neutrals:** A range of cool grays (Slate) that define the "container" architecture. 
- **Functional Accents:** Urgent states utilize a sharp red, while "Waiting" uses a warm amber to signify caution without triggering panic.

In dark mode, the system shifts to a deep charcoal-navy base to reduce eye strain during night shifts, maintaining high legibility through adjusted contrast ratios.

## Typography
The system uses **Inter** for all primary communication due to its exceptional legibility in data-dense environments. Its tall x-height ensures that patient names and medical codes remain readable even at small sizes.

For specialized technical data, such as timestamps, medical IDs, or queue numbers, **JetBrains Mono** is employed in a label capacity. This monospaced secondary font provides a "technical/precise" layer to the UI, making it easier for staff to scan alphanumeric sequences quickly. 

Tight letter-spacing is applied to larger headlines to maintain a premium, modern appearance, while body text uses standard tracking for maximum accessibility.

## Layout & Spacing
The layout follows a **Fluid-Fixed Hybrid** model. The main navigation resides in a fixed-width sidebar (260px), while the content area utilizes a fluid grid that expands to a maximum width of 1440px to prevent line lengths from becoming unreadable on ultra-wide monitors.

A strict **4px baseline grid** governs all spacing. 
- **Patient Lists/Tables:** Use compact vertical spacing (8px-12px) to maximize visibility of the queue.
- **Dashboard Widgets:** Use generous internal padding (24px) to create "breathing room" between disparate data sets.
- **Breakpoints:**
  - **Desktop (1024px+):** 12-column grid, 24px gutters.
  - **Tablet (768px - 1023px):** 8-column grid, 16px gutters, sidebar collapses to icons.
  - **Mobile (<767px):** 4-column grid, 16px gutters, stacked cards for patient entries.

## Elevation & Depth
The design system employs **Tonal Layering** supplemented by **Ambient Shadows**. Instead of heavy drop shadows, it uses subtle borders and nested backgrounds to signify hierarchy.

- **Level 0 (Base):** The main background (Slate 50 in light mode).
- **Level 1 (Cards/Containers):** Pure white surface with a 1px border (#E2E8F0) and a very soft, diffused shadow (0px 4px 12px rgba(0,0,0,0.03)).
- **Level 2 (Modals/Popovers):** Higher contrast shadow (0px 12px 32px rgba(0,0,0,0.08)) to indicate temporary interaction layers.
- **Level 3 (Urgent Overlays):** Uses a semi-transparent backdrop blur (8px) to focus the user's attention on critical alerts or life-safety notifications.

## Shapes
A **Rounded** (0.5rem) language is used throughout the system. This softened geometry helps reduce the "severity" of the medical environment while maintaining a structured, professional look.

- **Standard Buttons & Inputs:** 0.5rem (8px).
- **Patient Queue Cards:** 1rem (16px) for larger, high-level containers.
- **Status Chips:** Fully pill-shaped (999px) to distinguish them clearly from interactive buttons.
- **Checkboxes:** Slightly rounded (4px) to retain a crisp, functional feel.

## Components
Consistent component behavior is vital for high-speed clinical workflows.

- **Status Chips:** 
  - *Waiting:* Amber background, dark amber text.
  - *In Progress:* Primary blue background (low opacity), primary blue text.
  - *Completed:* Soft emerald background, dark green text.
  - *Urgent:* Solid red background, white text + pulsing animation.
- **Data Tables:** Feature "sticky" headers and first columns (Patient Name). Rows should use a subtle hover state (#F1F5F9) to assist eye tracking across data points.
- **Workflow Timelines:** Vertical tracks with 2px dashed lines and iconography representing clinical milestones (Triage, Doctor Assigned, Treatment).
- **Queue Cards:** Used in Kanban or List views. Must include a "Time in Queue" counter in the top-right corner using the `label-caps` font style.
- **Primary Buttons:** Solid Primary Blue with white text. Use a subtle inner-glow on hover to reinforce the "Premium" feel.
- **Input Fields:** Use a 1px Slate-200 border that transforms to a 2px Primary Blue ring on focus. Labels should always be visible above the input, never as placeholder-only.