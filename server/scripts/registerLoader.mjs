import { register } from 'node:module';

register('./testLoader.mjs', import.meta.url);
