import * as parseXML from 'xml2js';
import * as _isEmpty from 'lodash.isempty';
import * as _set from 'lodash.set';
import * as _uniq from 'lodash.uniq';
import {InvalidUserInputError} from '../errors';

export interface PkgTree {
  name: string;
  version: string;
  dependencies: {
    [dep: string]: PkgTree;
  };
  depType?: DepType;
  hasDevDependencies?: boolean;
  cyclic?: boolean;
  targetFrameworks?: string[];
  dependenciesWithUnknownVersions?: string[];
}

export interface DependencyWithoutVersion {
  name: string;
  withoutVersion: true;
}

export enum DepType {
  prod = 'prod',
  dev = 'dev',
}

export interface ReferenceInclude {
  Version?: string;
  Culture?: string;
  processorArchitecture?: string;
  PublicKeyToken?: string;
  name?: string;
}

export interface DependenciesDiscoveryResult {
  dependencies: { [dep: string]: PkgTree };
  hasDevDependencies: boolean;
  dependenciesWithUnknownVersions?: string[];
}

export enum ProjectJsonDepType {
  build = 'build',
  project = 'project',
  platform = 'platform',
  default = 'default',
}

export interface ProjectJsonManifestDependency {
  version: string;
  type?: ProjectJsonDepType;
}

export interface ProjectJsonManifest {
  dependencies: {
    [name: string]: ProjectJsonManifestDependency | string;
  };
}

export function getDependencyTreeFromProjectJson(manifestFile: ProjectJsonManifest, includeDev: boolean = false) {
  const depTree: PkgTree = {
    dependencies: {},
    hasDevDependencies: false,
    name: '',
    version: '',
  };

  for (const depName in manifestFile.dependencies) {
    if (!manifestFile.dependencies.hasOwnProperty(depName)) {
      continue;
    }
    const depValue = manifestFile.dependencies[depName];
    const version = (depValue as ProjectJsonManifestDependency).version || depValue;
    const isDev = (depValue as ProjectJsonManifestDependency).type === 'build';
    depTree.hasDevDependencies = depTree.hasDevDependencies || isDev;
    if (isDev && !includeDev) {
      continue;
    }
    depTree.dependencies[depName] = buildSubTreeFromProjectJson(depName, version, isDev);
  }
  return depTree;
}

function buildSubTreeFromProjectJson(name, version, isDev: boolean): PkgTree {
  const depSubTree: PkgTree = {
    depType: isDev ? DepType.dev : DepType.prod,
    dependencies: {},
    name,
    version,
  };

  return depSubTree;
}

export async function getDependencyTreeFromPackagesConfig(
  manifestFile, includeDev: boolean = false): Promise<PkgTree> {
  const depTree: PkgTree = {
    dependencies: {},
    hasDevDependencies: false,
    name: '',
    version: '',
  };

  const packageList = manifestFile?.packages?.package ?? [];

  for (const dep of packageList) {
    const depName = dep.$.id;
    const isDev = !!dep.$.developmentDependency;
    depTree.hasDevDependencies = depTree.hasDevDependencies || isDev;
    if (isDev && !includeDev) {
      continue;
    }
    depTree.dependencies[depName] = buildSubTreeFromPackagesConfig(dep, isDev);
  }

  return depTree;
}

function buildSubTreeFromPackagesConfig(dep, isDev: boolean): PkgTree {
  const depSubTree: PkgTree = {
    depType: isDev ? DepType.dev : DepType.prod,
    dependencies: {},
    name: dep.$.id,
    version: dep.$.version,
  };

  if (dep.$.targetFramework) {
    depSubTree.targetFrameworks = [dep.$.targetFramework];
  }

  return depSubTree;
}

export async function getDependencyTreeFromProjectFile(
  manifestFile,
  includeDev: boolean = false,
  propsMap: PropsLookup = {}): Promise<PkgTree> {
  const nameProperty = (manifestFile?.Project?.PropertyGroup ?? [])
    .find((propertyGroup) => {
      return 'PackageId' in propertyGroup
      || 'AssemblyName' in propertyGroup;
    }) || {};

  const name = (nameProperty.PackageId?.[0])
    || (nameProperty.AssemblyName?.[0])
    || '';

  const packageReferenceDeps =
    await getDependenciesFromPackageReference(manifestFile, includeDev, propsMap);
  const referenceIncludeDeps =
    await getDependenciesFromReferenceInclude(manifestFile, includeDev, propsMap);

  // order matters, the order deps are parsed in needs to be preserved and first seen kept
  // so applying the packageReferenceDeps last to override the second parsed
  const depTree: PkgTree = {
    dependencies: {
      ...referenceIncludeDeps.dependencies,
      ...packageReferenceDeps.dependencies,
    },
    hasDevDependencies: packageReferenceDeps.hasDevDependencies || referenceIncludeDeps.hasDevDependencies,
    name,
    version: '',
  };
  if (packageReferenceDeps.dependenciesWithUnknownVersions) {
    depTree.dependenciesWithUnknownVersions = packageReferenceDeps.dependenciesWithUnknownVersions;
  }
  if (referenceIncludeDeps.dependenciesWithUnknownVersions) {
    depTree.dependenciesWithUnknownVersions = referenceIncludeDeps.dependenciesWithUnknownVersions;
  }

  return depTree;
}

async function getDependenciesFromPackageReference(
  manifestFile,
  includeDev: boolean = false,
  propsMap: PropsLookup):
  Promise <DependenciesDiscoveryResult> {
  let dependenciesResult: DependenciesDiscoveryResult = {
    dependencies: {},
    hasDevDependencies: false,
  };
  const packageGroups = (manifestFile?.Project?.ItemGroup ?? [])
    .filter((itemGroup) => typeof itemGroup === 'object' && 'PackageReference' in itemGroup);

  if (!packageGroups.length) {
    return dependenciesResult;
  }

  for (const packageList of packageGroups) {
    dependenciesResult = processItemGroupForPackageReference(
      packageList, manifestFile, includeDev, dependenciesResult, propsMap);
  }

  return dependenciesResult;
}

function processItemGroupForPackageReference(
  packageList,
  manifestFile,
  includeDev: boolean,
  dependenciesResult,
  propsMap: PropsLookup) {
  const targetFrameworks: string[] = packageList?.$?.Condition ?? false ?
    getConditionalFrameworks(packageList.$.Condition) : [];

  for (const dep of packageList.PackageReference) {
    const depName = dep.$.Include;
    if (!depName) {
      // PackageReference Update is not yet supported
      continue;
    }
    const isDev = !!dep.$.developmentDependency;
    dependenciesResult.hasDevDependencies = dependenciesResult.hasDevDependencies || isDev;
    if (isDev && !includeDev) {
      continue;
    }
    const subDep = buildSubTreeFromPackageReference(
      dep, isDev, manifestFile, targetFrameworks, propsMap);
    if ((subDep as DependencyWithoutVersion).withoutVersion)  {
      dependenciesResult.dependenciesWithUnknownVersions = dependenciesResult.dependenciesWithUnknownVersions || [];
      dependenciesResult.dependenciesWithUnknownVersions.push(subDep.name);
    } else {
      dependenciesResult.dependencies[depName] = subDep as PkgTree;
    }
  }

  return dependenciesResult;
}

// TODO: almost same as getDependenciesFromPackageReference
async function getDependenciesFromReferenceInclude(manifestFile, includeDev: boolean = false, propsMap: PropsLookup):
  Promise <DependenciesDiscoveryResult> {

  let referenceIncludeResult: DependenciesDiscoveryResult = {
    dependencies: {},
    hasDevDependencies: false,
  };

  const referenceIncludeList =
  (manifestFile?.Project?.ItemGroup ?? [])
  .find((itemGroup) => typeof itemGroup === 'object' && 'Reference' in itemGroup);

  if (!referenceIncludeList) {
    return referenceIncludeResult;
  }

  referenceIncludeResult =
      processItemGroupForReferenceInclude(
        referenceIncludeList, manifestFile, includeDev, referenceIncludeResult, propsMap);

  return referenceIncludeResult;
}

function processItemGroupForReferenceInclude(
  packageList, manifestFile,  includeDev, dependenciesResult, propsMap) {
  const targetFrameworks: string[] = packageList?.$?.Condition ?? false ?
    getConditionalFrameworks(packageList.$.Condition) : [];

  for (const item of packageList.Reference) {
    const propertiesList = item.$.Include.split(',').map((i) => i.trim());
    const [depName, ...depInfoArray] = propertiesList;
    const depInfo: ReferenceInclude = {};

    if (!depName) {
      continue;
    }

    // TODO: identify dev deps @lili
    const isDev = false;

    dependenciesResult.hasDevDependencies = dependenciesResult.hasDevDependencies || isDev;
    if (isDev && !includeDev) {
      continue;
    }

    for (const itemValue of depInfoArray) {
      const propertyValuePair = itemValue.split('=');
      depInfo[propertyValuePair[0]] = propertyValuePair[1];
    }
    depInfo.name = depName;
    const subDep = buildSubTreeFromReferenceInclude(
      depInfo, isDev, manifestFile, targetFrameworks, propsMap);
    if ((subDep as DependencyWithoutVersion).withoutVersion)  {
      dependenciesResult.dependenciesWithUnknownVersions = dependenciesResult.dependenciesWithUnknownVersions || [];
      dependenciesResult.dependenciesWithUnknownVersions.push(subDep.name);
    } else {
      dependenciesResult.dependencies[depName] = subDep as PkgTree;
    }
  }

  return dependenciesResult;

}

function buildSubTreeFromReferenceInclude(
  dep, isDev: boolean, manifestFile, targetFrameworks: string[], propsMap: PropsLookup):
  PkgTree | DependencyWithoutVersion {
  const version = extractDependencyVersion(dep, manifestFile, propsMap) || '';
  if (!_isEmpty(version)) {
    const depSubTree: PkgTree = {
      depType: isDev ? DepType.dev : DepType.prod,
      dependencies: {},
      name: dep.name,
      // Version could be in attributes or as child node.
      version,
    };
    if (targetFrameworks.length) {
      depSubTree.targetFrameworks = targetFrameworks;
    }

    return depSubTree;
  } else {
    return {name: dep.name, withoutVersion: true};
  }
}

function buildSubTreeFromPackageReference(
  dep,
  isDev: boolean,
  manifestFile,
  targetFrameworks: string[],
  propsMap: PropsLookup):
  PkgTree | DependencyWithoutVersion {

  const version = extractDependencyVersion(dep, manifestFile, propsMap) || '';
  if (!_isEmpty(version)) {

    const depSubTree: PkgTree = {
      depType: isDev ? DepType.dev : DepType.prod,
      dependencies: {},
      name: dep.$.Include,
      // Version could be in attributes or as child node.
      version,
    };

    if (targetFrameworks.length) {
      depSubTree.targetFrameworks = targetFrameworks;
    }

    return depSubTree;
  } else {
    return {name: dep.$.Include, withoutVersion: true};
  }
}

function extractDependencyVersion(dep, manifestFile, propsMap): string | null {
  const VARS_MATCHER = /^\$\((.*?)\)/;
  let version  = dep?.$?.Version || dep?.Version;
  if (Array.isArray(version)) {
    version = version[0];
  }
  const variableVersion = version && version.match(VARS_MATCHER);
  if (!variableVersion) {
    return version;
  }
  // version is a variable, extract it from manifest or props lookup
  const propertyName = variableVersion[1];
  const propertyMap = {...propsMap, ...getPropertiesMap(manifestFile)};
  return propertyMap?.[propertyName] ?? null;
}

function getConditionalFrameworks(condition: string) {
  const regexp = /\(TargetFramework\)'\s?==\s? '((\w|\d|\.)*)'/g;
  const frameworks: string[] = [];
  let match = regexp.exec(condition);

  while (match !== null) {
    frameworks.push(match[1]);
    match = regexp.exec(condition);
  }

  return frameworks;
}

export async function parseXmlFile(manifestFileContents: string): Promise<object> {
  return new Promise((resolve, reject) => {
    parseXML
    .parseString(manifestFileContents, (err, result) => {
      if (err) {
        const e = new InvalidUserInputError('xml file parsing failed');
        return reject(e);
      }
      return resolve(result);
    });
  });
}

export interface PropsLookup {
  [name: string]: string;
}

export function getPropertiesMap(propsContents: any): PropsLookup {
  const projectPropertyGroup = propsContents?.Project?.PropertyGroup ?? [];
  const props: PropsLookup = {};
  if (!projectPropertyGroup.length) {
    return props;
  }

  for (const group of projectPropertyGroup) {
    for (const key of Object.keys(group)) {
      _set(props, key, group[key][0]);
    }
  }
  return props;
}

export function getTargetFrameworksFromProjectFile(manifestFile) {
  let targetFrameworksResult: string[] = [];
  const projectPropertyGroup = manifestFile?.Project?.PropertyGroup ?? [];

  if (!projectPropertyGroup ) {
    return targetFrameworksResult;
  }
  const propertyList = projectPropertyGroup
    .find((propertyGroup) => {
        return 'TargetFramework' in propertyGroup
        || 'TargetFrameworks' in propertyGroup
        || 'TargetFrameworkVersion' in propertyGroup;
      }) || {};

  if (_isEmpty(propertyList)) {
    return targetFrameworksResult;
  }
  // The TargetFrameworks value is expected to be a string (containing a list of frameworks ; separated).
  // This value is normally parsed from XML into a string variable.
  // However when the XML element has attributes, it is parsed into an object, with the value stored in '_'.
  if (propertyList.TargetFrameworks) {
    for (const item of propertyList.TargetFrameworks) {
      const rawTargetFrameworks = typeof item === 'object' ? item._ : item;
      const parsedTargetFrameworks = rawTargetFrameworks.split(';').filter((x) => !_isEmpty(x));
      targetFrameworksResult = [...targetFrameworksResult, ...parsedTargetFrameworks ];
    }
  }
  // TargetFrameworkVersion is expected to be a string containing only one item
  // TargetFrameworkVersion also implies .NETFramework, for convenience
  // return longer version
  if (propertyList.TargetFrameworkVersion) {
    targetFrameworksResult.push(`.NETFramework,Version=${propertyList.TargetFrameworkVersion[0]}`);
  }
  // TargetFrameworks is expected to be a string
  if (propertyList.TargetFramework) {
    targetFrameworksResult = [...targetFrameworksResult, ...propertyList.TargetFramework];
  }

  return _uniq(targetFrameworksResult);
}

export function getTargetFrameworksFromProjectConfig(manifestFile) {
  const targetFrameworksResult: string[] = [];
  const packages = manifestFile?.packages?.package ?? [];

  for (const item of packages) {
    const targetFramework = item.$.targetFramework;
    if (!targetFramework) {
      continue;
    }

    if (!targetFrameworksResult.includes(targetFramework)) {
      targetFrameworksResult.push(targetFramework);
    }
  }

  return targetFrameworksResult;
}

export function getTargetFrameworksFromProjectJson(manifestFile) {
  return Object.keys(manifestFile?.frameworks ?? {});
}

export function getTargetFrameworksFromProjectAssetsJson(manifestFile) {
  return Object.keys(manifestFile?.targets ?? {});
}
