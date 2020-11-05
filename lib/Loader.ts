import * as fs from 'fs';
import type { Readable } from 'stream';
import NodeUtil = require('util');
import type * as RDF from 'rdf-js';
import type { Resource } from 'rdf-object';
import { RdfObjectLoader } from 'rdf-object';
import { ComponentFactory } from './factory/ComponentFactory';
import type { IComponentFactory, ICreationSettings } from './factory/IComponentFactory';
import { RdfParser } from './rdf/RdfParser';
import Util = require('./Util');
import { resourceIdToString, resourceToString } from './Util';

/**
 * A loader class for component configs.
 * Modules must first be registered to this loader.
 * After that, components can be instantiated.
 * Components with the same URI will only be instantiated once.
 */
export class Loader {
  public readonly objectLoader: RdfObjectLoader;

  public readonly properties: ILoaderProperties;

  public componentResources: Record<string, Resource> = {};
  /**
   * Require overrides.
   * Require name as path, require override as value.
   */
  protected readonly overrideRequireNames: Record<string, string> = {};

  protected readonly runTypeConfigs: Record<string, Resource[]> = {};
  protected readonly instances: Record<string, any> = {};
  protected registrationFinalized = false;

  public constructor(properties?: ILoaderProperties) {
    this.properties = properties || {};

    this.objectLoader = new RdfObjectLoader({
      context: JSON.parse(fs.readFileSync(`${__dirname}/../components/context.jsonld`, 'utf8')),
    });

    if (this.properties.mainModulePath) {
      Util.setMainModulePath(this.properties.mainModulePath);
    }
    if (!('absolutizeRelativePaths' in this.properties)) {
      this.properties.absolutizeRelativePaths = true;
    }
  }

  public async getContexts(): Promise<Record<string, any>> {
    if (!this.properties.contexts) {
      this.properties.contexts = await Util.getAvailableContexts();
    }
    return this.properties.contexts;
  }

  public async getImportPaths(): Promise<Record<string, string>> {
    if (!this.properties.importPaths) {
      this.properties.importPaths = await Util.getAvailableImportPaths();
    }
    return this.properties.importPaths;
  }

  /**
   * Register a new component.
   * This will ensure that component configs referring to this component as type are recognized.
   * @param componentResource A component resource.
   */
  public registerComponentResource(componentResource: Resource): void {
    if (this.registrationFinalized) {
      throw new Error(`Tried registering a component ${resourceIdToString(componentResource, this.objectLoader)} after the loader has been finalized.`);
    }
    this._requireValidComponent(componentResource);
    this.componentResources[componentResource.value] = componentResource;
  }

  /**
   * Check if the given resource is a valid component.
   * @param componentResource A resource.
   * @returns {boolean} If the resource is a valid component.
   */
  public _isValidComponent(componentResource: Resource): boolean {
    return componentResource.isA(Util.IRI_ABSTRACT_CLASS) ||
            componentResource.isA(Util.IRI_CLASS) ||
            componentResource.isA(Util.IRI_COMPONENT_INSTANCE);
  }

  /**
   * Require that the given resource is a valid component,
   * otherwise and error is thrown.
   * @param componentResource A resource.
   * @param referencingComponent The optional component referencing the given component.
   */
  public _requireValidComponent(componentResource: Resource, referencingComponent?: Resource): void {
    if (!this._isValidComponent(componentResource)) {
      throw new Error(`The referenced resource ${resourceIdToString(componentResource, this.objectLoader)} is not a valid ` +
                `component resource, either it is not defined or incorrectly referenced${
                  referencingComponent ? ` by ${resourceIdToString(referencingComponent, this.objectLoader)}.` : '.'}`);
    }
  }

  /**
   * Let the given component inherit parameters from the given component(s) if applicable.
   * @param componentResource The component resource
   * @param inheritValues The component inheritValues to inherit from.
   */
  public inheritParameters(componentResource: Resource, inheritValues?: Resource[]): void {
    if (inheritValues) {
      inheritValues.forEach((component: Resource) => {
        this._requireValidComponent(component, componentResource);
        if (this._isValidComponent(component)) {
          if (component.property.parameters) {
            component.properties.parameters.forEach((parameter: Resource) => {
              if (!componentResource.properties.parameters.includes(parameter)) {
                componentResource.properties.parameters.push(parameter);
              }
            });
            this.inheritParameters(componentResource, component.properties.inheritValues);
          }
        }
      });
    }
  }

  /**
   * Let the given component inherit constructor mappings from the given component(s) if applicable.
   * @param componentResource The component resource
   */
  public inheritConstructorParameters(componentResource: Resource): void {
    if (componentResource.property.constructorArguments) {
      if (!componentResource.property.constructorArguments.list) {
        throw new Error(`Detected invalid constructor arguments for component "${resourceIdToString(componentResource, this.objectLoader)}": arguments are not an RDF list.`);
      }
      componentResource.property.constructorArguments.list.forEach((object: Resource) => {
        if (object.property.inheritValues) {
          this.inheritObjectFields(object, object.properties.inheritValues);
        }
      });
    }
  }

  /**
   * Let the given object inherit the given fields from the given component(s) if applicable.
   * @param object The object resource
   * @param inheritValues The objects to inherit from.
   */
  public inheritObjectFields(object: Resource, inheritValues?: Resource[]): void {
    if (inheritValues) {
      inheritValues.forEach((superObject: Resource) => {
        if (superObject.property.fields) {
          superObject.properties.fields.forEach((field: Resource) => {
            if (!object.properties.fields.includes(field)) {
              object.properties.fields.push(field);
            }
          });
        } else if (!superObject.isA(Util.DF.namedNode(`${Util.PREFIXES.om}ObjectMapping`)) && !superObject.property.inheritValues && !superObject.property.onParameter) {
          throw new Error(`The referenced constructor mappings object ${resourceIdToString(superObject, this.objectLoader)
          } from ${resourceIdToString(object, this.objectLoader)} is not valid, i.e., it doesn't contain mapping fields ` +
                        `, has the om:ObjectMapping type or has a superclass. ` +
                        `It possibly is incorrectly referenced or not defined at all.`);
        }
        if (superObject.property.inheritValues) {
          this.inheritObjectFields(object, superObject.properties.inheritValues);
        }
      });
    }
  }

  /**
   * Register a new module and its components.
   * This will ensure that component configs referring to components as types of this module are recognized.
   * @param moduleResource A module resource.
   */
  public registerModuleResource(moduleResource: Resource): void {
    if (this.registrationFinalized) {
      throw new Error(`Tried registering a module ${resourceIdToString(moduleResource, this.objectLoader)} after the loader has been finalized.`);
    }
    if (moduleResource.properties.components) {
      moduleResource.properties.components.forEach((component: Resource) => {
        component.property.module = moduleResource;
        this.registerComponentResource(component);
      });
    } else if (!moduleResource.property.imports) {
      throw new Error(`Tried to register the module ${resourceIdToString(moduleResource, this.objectLoader)} that has no components.`);
    }
  }

  /**
   * Register new modules and their components.
   * This will ensure that component configs referring to components as types of these modules are recognized.
   * @param moduleResourceStream A triple stream containing modules.
   * @returns {Promise<T>} A promise that resolves once loading has finished.
   */
  public async registerModuleResourcesStream(moduleResourceStream: RDF.Stream & Readable): Promise<void> {
    await this.objectLoader.import(moduleResourceStream);
    for (const resource of Object.values(this.objectLoader.resources)) {
      if (resource.isA(Util.IRI_MODULE)) {
        this.registerModuleResource(resource);
      }
    }
  }

  /**
   * Register new modules and their components.
   * This will ensure that component configs referring to components as types of these modules are recognized.
   * @param moduleResourceUrl An RDF document URL
   * @param fromPath The path to base relative paths on. This will typically be __dirname.
   * @returns {Promise<T>} A promise that resolves once loading has finished.
   */
  public async registerModuleResourcesUrl(moduleResourceUrl: string, fromPath?: string): Promise<void> {
    const [ contexts, importPaths ] = await Promise.all([ this.getContexts(), this.getImportPaths() ]);
    const data = await Util.getContentsFromUrlOrPath(moduleResourceUrl, fromPath);
    return this.registerModuleResourcesStream(new RdfParser().parse(data, {
      fromPath,
      path: moduleResourceUrl,
      contexts,
      importPaths,
      ignoreImports: false,
      absolutizeRelativePaths: this.properties.absolutizeRelativePaths,
    }));
  }

  /**
   * Register all reachable modules and their components.
   * This will interpret the package.json from the main module and all its dependencies for discovering modules.
   * This will ensure that component configs referring to components as types of these modules are recognized.
   * @returns {Promise<T>} A promise that resolves once loading has finished.
   */
  public async registerAvailableModuleResources(): Promise<void> {
    const data = await Util.getAvailableModuleComponentPaths();
    await Promise.all(Object.values(data)
      .map((moduleResourceUrl: string) => this.registerModuleResourcesUrl(moduleResourceUrl)));
  }

  /**
   * Get a component config constructor based on a Resource.
   * @param configResource A config resource.
   * @returns The component factory.
   */
  public getConfigConstructor(configResource: Resource): IComponentFactory {
    const allTypes: string[] = [];
    const componentTypes: Resource[] = configResource.properties.types
      .reduce((types: Resource[], typeUri: Resource) => {
        const componentResource: Resource = this.componentResources[typeUri.value];
        allTypes.push(typeUri.value);
        if (componentResource) {
          types.push(componentResource);
          if (!this.runTypeConfigs[componentResource.value]) {
            this.runTypeConfigs[componentResource.value] = [];
          }
          this.runTypeConfigs[componentResource.value].push(configResource);
        }
        return types;
      }, []);
    if (componentTypes.length !== 1 &&
      !configResource.property.requireName &&
      !configResource.property.requireElement) {
      throw new Error(`Could not run config ${resourceIdToString(configResource, this.objectLoader)} because exactly one valid component type ` +
                `was expected, while ${componentTypes.length} were found in the defined types [${allTypes}]. ` +
                `Alternatively, the requireName and requireElement must be provided.\nFound: ${
                  resourceToString(configResource)}\nAll available usable types: [\n${
                  Object.keys(this.componentResources).join(',\n')}\n]`);
    }
    let componentResource: Resource | undefined;
    let moduleResource: Resource | undefined;
    if (componentTypes.length > 0) {
      componentResource = componentTypes[0];
      moduleResource = componentResource.property.module;
      if (!moduleResource) {
        throw new Error(`No module was found for the component ${resourceIdToString(componentResource, this.objectLoader)}`);
      }

      this.inheritParameterValues(configResource, componentResource);
    }

    return new ComponentFactory(moduleResource, componentResource, configResource, this.overrideRequireNames, this);
  }

  /**
   * Instantiate a component based on a Resource.
   * @param configResource A config resource.
   * @param settings The settings for creating the instance.
   * @returns {any} The run instance.
   */
  public async instantiate(configResource: Resource, settings?: ICreationSettings): Promise<any> {
    settings = settings || {};
    // Check if this resource is required as argument in its own chain,
    // if so, return a dummy value, to avoid infinite recursion.
    const resourceBlacklist = settings.resourceBlacklist || {};
    if (resourceBlacklist[configResource.value]) {
      return {};
    }

    // Before instantiating, first check if the resource is a variable
    if (configResource.isA(Util.IRI_VARIABLE)) {
      if (settings.serializations) {
        if (settings.asFunction) {
          return `getVariableValue('${configResource.value}')`;
        }
        throw new Error(`Detected a variable during config compilation: ${resourceIdToString(configResource, this.objectLoader)}. Variables are not supported, but require the -f flag to expose the compiled config as function.`);
      } else {
        const value = settings.variables ? settings.variables[configResource.value] : undefined;
        if (value === undefined) {
          throw new Error(`Undefined variable: ${resourceIdToString(configResource, this.objectLoader)}`);
        }
        return value;
      }
    }

    if (!this.instances[configResource.value]) {
      const subBlackList: Record<string, boolean> = { ...resourceBlacklist };
      subBlackList[configResource.value] = true;
      this.instances[configResource.value] = this.getConfigConstructor(configResource).create(
        { resourceBlacklist: subBlackList, ...settings },
      );
    }
    return this.instances[configResource.value];
  }

  /**
   * Let then given config inherit parameter values from referenced passed configs.
   * @param configResource The config
   * @param componentResource The component
   */
  public inheritParameterValues(configResource: Resource, componentResource: Resource): void {
    // Inherit parameter values from passed instances of the given types
    if (componentResource.property.parameters) {
      componentResource.properties.parameters.forEach((parameter: Resource) => {
        // Collect all owl:Restriction's
        const restrictions: Resource[] = parameter.properties.inheritValues
          .reduce((acc: Resource[], clazz: Resource) => {
            if (clazz.properties.types.reduce((subAcc: boolean, type: Resource) => subAcc ||
              type.value === `${Util.PREFIXES.owl}Restriction`, false)) {
              acc.push(clazz);
            }
            return acc;
          }, []);

        restrictions.forEach((restriction: Resource) => {
          if (restriction.property.from) {
            if (!restriction.property.onParameter) {
              throw new Error(`Parameters that inherit values must refer to a property: ${resourceToString(parameter)}`);
            }

            restriction.properties.from.forEach((componentType: Resource) => {
              if (componentType.type !== 'NamedNode') {
                throw new Error(`Parameter inheritance values must refer to component type identifiers, not literals: ${resourceToString(componentType)}`);
              }

              const typeInstances: Resource[] = this.runTypeConfigs[componentType.value];
              if (typeInstances) {
                typeInstances.forEach((instance: Resource) => {
                  restriction.properties.onParameter.forEach((parentParameter: Resource) => {
                    // TODO: this might be a bug in the JSON-LD parser
                    // if (parentParameter.termType !== 'NamedNode') {
                    // throw new Error('Parameters that inherit values must refer to sub properties as URI\'s: '
                    // + JSON.stringify(parentParameter));
                    // }
                    if (instance.property[parentParameter.value]) {
                      // Copy the parameters
                      for (const value of instance.properties[parentParameter.value]) {
                        configResource.properties[parentParameter.value].push(value);
                      }

                      // Also add the parameter to the parameter type list
                      if (!componentResource.properties.parameters.includes(parentParameter)) {
                        componentResource.properties.parameters.push(parentParameter);
                      }
                    }
                  });
                });
              }
            });
          }
        });
      });
    }
  }

  /**
   * Set the loader to a state where it doesn't accept anymore module and component registrations.
   * This is required for post-processing the components, for actions such as parameter inheritance,
   * index creation and cleanup.
   */
  public finalizeRegistration(): void {
    if (this.registrationFinalized) {
      throw new Error('Attempted to finalize and already finalized loader.');
    }

    // Component parameter inheritance
    for (const componentResource of Object.values(this.componentResources)) {
      this.inheritParameters(componentResource, componentResource.properties.inheritValues);
      this.inheritConstructorParameters(componentResource);
    }

    // Freeze component resources
    this.componentResources = Object.freeze(this.componentResources);

    this.registrationFinalized = true;

    Util.NODE_MODULES_PACKAGE_CONTENTS = {};
  }

  public checkFinalizeRegistration(): void {
    if (!this.registrationFinalized) {
      this.finalizeRegistration();
    }
  }

  /**
   * Get a component config constructor based on a config URI.
   * @param configResourceUri The config resource URI.
   * @param configResourceStream A triple stream containing at least the given config.
   * @returns {Promise<T>} A promise resolving to the component constructor.
   */
  public async getConfigConstructorFromStream(
    configResourceUri: string,
    configResourceStream: RDF.Stream & Readable,
  ): Promise<IComponentFactory> {
    this.checkFinalizeRegistration();
    await this.objectLoader.import(configResourceStream);

    const configResource: Resource = this.objectLoader.resources[configResourceUri];
    if (!configResource) {
      throw new Error(`Could not find a component config with URI ${configResourceUri} in the triple stream.`);
    }
    return this.getConfigConstructor(configResource);
  }

  /**
   * Instantiate a component based on a config URI and a stream.
   * @param configResourceUri The config resource URI.
   * @param configResourceStream A triple stream containing at least the given config.
   * @param settings The settings for creating the instance.
   * @returns {Promise<T>} A promise resolving to the run instance.
   */
  public async instantiateFromStream(
    configResourceUri: string,
    configResourceStream: RDF.Stream & Readable,
    settings?: ICreationSettings,
  ): Promise<any> {
    this.checkFinalizeRegistration();
    await this.objectLoader.import(configResourceStream);

    const configResource: Resource = this.objectLoader.resources[configResourceUri];
    if (!configResource) {
      throw new Error(`Could not find a component config with URI ${configResourceUri} in the triple stream.`);
    }
    return this.instantiate(configResource, settings);
  }

  /**
   * Run a component config based on a config URI.
   * @param configResourceUri The config resource URI.
   * @param configResourceUrl An RDF document URL
   * @param fromPath The path to base relative paths on. This will typically be __dirname.
   *                 Default is the current running directory.
   * @returns {Promise<T>} A promise resolving to the run instance.
   */
  public async getConfigConstructorFromUrl(
    configResourceUri: string,
    configResourceUrl: string,
    fromPath?: string,
  ): Promise<IComponentFactory> {
    this.checkFinalizeRegistration();
    const [ contexts, importPaths ] = await Promise.all([ this.getContexts(), this.getImportPaths() ]);
    const data = await Util.getContentsFromUrlOrPath(configResourceUrl, fromPath);
    return this.getConfigConstructorFromStream(configResourceUri, new RdfParser().parse(data, {
      fromPath,
      path: configResourceUrl,
      contexts,
      importPaths,
      ignoreImports: false,
      absolutizeRelativePaths: this.properties.absolutizeRelativePaths,
    }));
  }

  /**
   * Instantiate a component based on a config URI.
   * @param configResourceUri The config resource URI.
   * @param configResourceUrl An RDF document URL
   * @param fromPath The path to base relative paths on. This will typically be __dirname.
   *                 Default is the current running directory.
   * @param settings The settings for creating the instance.
   * @returns {Promise<T>} A promise resolving to the run instance.
   */
  public async instantiateFromUrl(
    configResourceUri: string,
    configResourceUrl: string,
    fromPath?: string,
    settings?: ICreationSettings,
  ): Promise<any> {
    const [ contexts, importPaths ] = await Promise.all([ this.getContexts(), this.getImportPaths() ]);
    const data = await Util.getContentsFromUrlOrPath(configResourceUrl, fromPath);
    return this.instantiateFromStream(configResourceUri, new RdfParser().parse(data, {
      fromPath,
      path: configResourceUrl,
      contexts,
      importPaths,
      ignoreImports: false,
      absolutizeRelativePaths: this.properties.absolutizeRelativePaths,
    }), settings);
  }

  /**
   * Instantiate a component based on component URI and a set of parameters.
   * @param componentUri The URI of a component.
   * @param params A dictionary with named parameters.
   * @param settings The settings for creating the instance.
   * @returns {any} The run instance.
   */
  public instantiateManually(componentUri: string, params: Record<string, string>, settings?: ICreationSettings): any {
    this.checkFinalizeRegistration();
    const componentResource: Resource = this.componentResources[componentUri];
    if (!componentResource) {
      throw new Error(`Could not find a component for URI ${componentUri}`);
    }
    const moduleResource: Resource = componentResource.property.module;
    if (!moduleResource) {
      throw new Error(`No module was found for the component ${resourceIdToString(componentResource, this.objectLoader)}`);
    }
    const configResource = this.objectLoader.createCompactedResource({});
    Object.keys(params).forEach((key: string) => {
      configResource.property[key] = this.objectLoader.createCompactedResource(`"${params[key]}"`);
    });
    const constructor: ComponentFactory = new ComponentFactory(
      moduleResource,
      componentResource,
      configResource,
      this.overrideRequireNames,
      this,
    );
    return constructor.create(settings);
  }
}

export interface ILoaderProperties {
  absolutizeRelativePaths?: boolean;
  contexts?: Record<string, any>;
  importPaths?: Record<string, string>;
  mainModulePath?: string;
}
