/** A machine as the infra API lists it. */
export interface InfraMachine {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  noteCount: number;
  createdAt: string;
  updatedAt: string;
}
