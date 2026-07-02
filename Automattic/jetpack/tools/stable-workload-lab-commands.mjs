#!/usr/bin/env node
import { emitStableWorkloadLabCommands } from '../../../shared/stable-workload-lab-command-planner.mjs';

emitStableWorkloadLabCommands({
  moduleUrl: import.meta.url,
  productLabel: 'Jetpack',
  component: 'jetpack',
  rigId: 'jetpack-api-route-inventory',
  schema: 'homeboy-rigs/jetpack-stable-lab-command-plan/v1',
  defaultRunIdPrefix: 'jetpack-stable',
});
