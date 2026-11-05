// Every method the storage interface offers, derived from `types.ts` with the compiler (#1008), so a method added there is known to the
// tests without editing them. A path reads like a call: `fleet.upsertSession`, `peers().rights.propose`, `activity().history.list`.
// A property that is a function is a method; a property that is an object (or that a call returns, when it is not a Promise) is walked.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '@typescript/typescript6';

const TYPES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'types.ts');
const MAX_DEPTH = 4;

export function storageMethods(): string[] {
  const program = ts.createProgram([TYPES], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, skipLibCheck: true, noEmit: true, types: [],
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(TYPES)!;
  let storage: ts.Type | undefined;
  ts.forEachChild(sf, (n) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === 'Storage') storage = checker.getTypeAtLocation(n.name);
  });
  if (!storage) throw new Error('types.ts has no Storage interface');
  const out = new Set<string>();
  const walk = (type: ts.Type, prefix: string, depth: number): void => {
    for (const prop of checker.getPropertiesOfType(type)) {
      const t = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(prop, sf));
      const sigs = t.getCallSignatures();
      const name = `${prefix}${prop.name}`;
      if (sigs.length) {
        const ret = checker.getReturnTypeOfSignature(sigs[0]!);
        const promise = ret.symbol?.name === 'Promise';
        const isObject = !promise && (ret.flags & ts.TypeFlags.Object) !== 0 && checker.getPropertiesOfType(ret).length > 0 && ret.getCallSignatures().length === 0;
        if (isObject && depth < MAX_DEPTH && !['Array', 'Map', 'Set'].includes(ret.symbol?.name ?? '')) walk(ret, `${name}().`, depth + 1);
        else out.add(name);
      } else if ((t.flags & ts.TypeFlags.Object) !== 0 && depth < MAX_DEPTH && checker.getPropertiesOfType(t).length > 0 && !['Array', 'Map', 'Set'].includes(t.symbol?.name ?? '')) {
        walk(t, `${name}.`, depth + 1);
      }
    }
  };
  walk(storage, '', 0);
  return [...out].sort((a, b) => a.localeCompare(b));
}
