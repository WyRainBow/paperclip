import { api } from "./client";

export interface PersonalFile {
  id: string;
  companyId: string;
  userId: string;
  kind: string;
  path: string;
  currentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalFileVersionSummary {
  id: string;
  revisionNumber: number;
  contentHash: string;
  label: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

export interface PersonalFileVersion extends PersonalFileVersionSummary {
  fileId: string;
  content: string;
}

export const personalFilesApi = {
  list: (companyId: string) =>
    api.get<PersonalFile[]>(`/companies/${companyId}/personal-files`),
  versions: (companyId: string, fileId: string) =>
    api.get<PersonalFileVersionSummary[]>(`/companies/${companyId}/personal-files/${fileId}/versions`),
  version: (companyId: string, fileId: string, revisionNumber: number) =>
    api.get<PersonalFileVersion>(`/companies/${companyId}/personal-files/${fileId}/versions/${revisionNumber}`),
};
