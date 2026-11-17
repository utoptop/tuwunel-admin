import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
test("release cleanup keeps current, container-referenced and unrelated images", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import importlib.util
spec=importlib.util.spec_from_file_location('release','scripts/release.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
def img(id='old',tags=None,source=r.SOURCE):
 return {'Id':id,'RepoTags':tags if tags is not None else [r.IMAGE+':1.2'],'Config':{'Labels':{'org.opencontainers.image.source':source}}}
assert r.removable(img(),{'current','used'})
assert r.removable(img(tags=[]),set())
assert not r.removable(img(id='current'),{'current','used'})
assert not r.removable(img(id='used'),{'current','used'})
assert not r.removable(img(tags=['another-app:latest']),set())
assert not r.removable(img(source='other-project'),set())
`,
    ],
    { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  assert.equal(result.status, 0, result.stderr);
});
