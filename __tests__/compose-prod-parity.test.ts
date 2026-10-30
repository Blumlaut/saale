import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * The compose files describe one stack twice.
 *
 * `docker-compose.prod.yml` pulls the images a release publishes, and
 * `docker-compose.yml` builds the same services from the checkout. A service
 * that gains an environment variable, a volume or a port in one file and not
 * the other deploys as a different stack, so this test holds the two together
 * and says which key drifted.
 */

const ROOT = path.resolve(__dirname, "..");

interface Service {
  image?: unknown;
  build?: unknown;
  environment?: unknown;
  volumes?: unknown;
  ports?: unknown;
}

interface Compose {
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, unknown>;
}

function load(file: string): Compose {
  return parse(readFileSync(path.join(ROOT, file), "utf8")) as Compose;
}

const source = load("docker-compose.yml");
const prod = load("docker-compose.prod.yml");

/** `KEY=value` list entries and `KEY: value` mappings both reduce to the key. */
function environmentKeys(service: Service | undefined): string[] {
  const environment = service?.environment;
  const entries = Array.isArray(environment)
    ? environment.map((entry) => String(entry))
    : Object.keys((environment ?? {}) as Record<string, unknown>);
  return entries.map((entry) => entry.split("=")[0]!).sort();
}

describe("the prod compose file", () => {
  it("describes the same services", () => {
    expect(Object.keys(prod.services).sort()).toEqual(Object.keys(source.services).sort());
  });

  it("builds nothing", () => {
    for (const [name, service] of Object.entries(prod.services)) {
      expect(service.build, `${name} still builds`).toBeUndefined();
    }
  });

  it("pulls the app images under the release version", () => {
    for (const name of ["web", "worker", "migrate", "sandbox-exec"]) {
      expect(prod.services[name]?.image, name).toContain("ghcr.io/blumlaut/");
      expect(prod.services[name]?.image, name).toContain("${SAALE_VERSION:-latest}");
    }
  });

  it("points per-user containers at the pulled sandbox image", () => {
    const environment = prod.services["sandbox-exec"]?.environment;
    expect(environment).toContain(
      "SANDBOX_CONTAINER_IMAGE=ghcr.io/blumlaut/saale-sandbox:${SAALE_VERSION:-latest}",
    );
  });

  it("carries every environment variable of the source file", () => {
    for (const [name, service] of Object.entries(source.services)) {
      expect(environmentKeys(prod.services[name]), name).toEqual(environmentKeys(service));
    }
  });

  it("mounts the same volumes and publishes the same ports", () => {
    for (const [name, service] of Object.entries(source.services)) {
      expect(prod.services[name]?.volumes, name).toEqual(service.volumes);
      expect(prod.services[name]?.ports, name).toEqual(service.ports);
    }
  });

  it("declares the same volumes and networks", () => {
    expect(Object.keys(prod.volumes ?? {}).sort()).toEqual(
      Object.keys(source.volumes ?? {}).sort(),
    );
    expect(Object.keys(prod.networks ?? {}).sort()).toEqual(
      Object.keys(source.networks ?? {}).sort(),
    );
  });
});
