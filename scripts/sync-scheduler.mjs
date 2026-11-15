// Copies the scheduler module next to the edge function that runs it.
// Supabase edge functions can only import files inside their own folder, so
// the function gets a copy; src/lib/scheduler/scheduler.ts stays the source.
// Run `npm run sync:scheduler` after changing the scheduler, then redeploy:
//   supabase functions deploy replan
import { copyFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
copyFileSync(resolve(root, 'src/lib/scheduler/scheduler.ts'), resolve(root, 'supabase/functions/replan/scheduler.ts'))
console.log('Copied scheduler.ts into supabase/functions/replan/')
