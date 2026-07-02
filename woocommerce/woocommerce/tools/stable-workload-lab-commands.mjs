#!/usr/bin/env node
import { emitStableWorkloadLabCommands } from '../../../shared/stable-workload-lab-command-planner.mjs';

emitStableWorkloadLabCommands({
  moduleUrl: import.meta.url,
  productLabel: 'Woo',
  component: 'woocommerce',
  rigId: 'woocommerce-performance',
  schema: 'homeboy-rigs/woocommerce-stable-lab-command-plan/v1',
  defaultRunIdPrefix: 'woo-stable',
});
