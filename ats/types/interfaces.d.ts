// Documentation-only TypeScript-style interfaces for the ATS module.

export interface CompanyConfig {
  id: string;
  name: string;
  type: 'comeet' | 'greenhouse';
  uid: string;
  apiBaseUrl?: string;
  enabled?: boolean;
}

export interface UnifiedJob {
  jobId: string;
  source: 'comeet' | 'greenhouse';
  sourceCompanyId: string;
  title: string;
  location: string;
  url: string;
  description: string | null;
  raw: any;
}

export interface CompanyRunStats {
  companyId: string;
  source: 'comeet' | 'greenhouse';
  fetched: number;
  kept: number;
  droppedLocation: number;
  droppedSemantic: number;
  errors: number;
}

export interface AtsRunSummary {
  startTime: string;
  endTime: string | null;
  status: 'IN_PROGRESS' | 'SUCCESS' | 'PARTIAL_FAIL' | 'ERROR';
  companiesTotal: number;
  companiesSucceeded: number;
  companiesFailed: number;
  companies: CompanyRunStats[];
}


