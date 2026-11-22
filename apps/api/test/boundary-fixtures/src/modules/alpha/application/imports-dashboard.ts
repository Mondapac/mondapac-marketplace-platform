// Violation (nothing-imports-dashboard): a module imports the dashboard module, even through its
// entry point; the dashboard composes other modules and is never a path between them.
import { dashboardModule } from '../../dashboard';

export const usesDashboard = dashboardModule;
