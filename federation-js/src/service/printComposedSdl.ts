import {
  GraphQLSchema,
  isSpecifiedDirective,
  isIntrospectionType,
  isSpecifiedScalarType,
  GraphQLNamedType,
  GraphQLDirective,
  isScalarType,
  isObjectType,
  isInterfaceType,
  isUnionType,
  isEnumType,
  isInputObjectType,
  GraphQLScalarType,
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLUnionType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLArgument,
  GraphQLInputField,
  astFromValue,
  print,
  GraphQLField,
  GraphQLEnumValue,
  GraphQLString,
  DEFAULT_DEPRECATION_REASON,
  ASTNode,
  SelectionNode,
} from 'graphql';
import { Maybe, ServiceDefinition, FederationType, FederationField } from '../composition';
import { isFederationType } from '../types';
import { isFederationDirective } from '../composition/utils';
import csdlDefinitions from '../csdlDefinitions';

type Options = {
  /**
   * Descriptions are defined as preceding string literals, however an older
   * experimental version of the SDL supported preceding comments as
   * descriptions. Set to true to enable this deprecated behavior.
   * This option is provided to ease adoption and will be removed in v16.
   *
   * Default: false
   */
  commentDescriptions?: boolean;
};

/**
 * Accepts options as a second argument:
 *
 *    - commentDescriptions:
 *        Provide true to use preceding comments as the description.
 *
 */
export function printComposedSdl(
  schema: GraphQLSchema,
  serviceList: ServiceDefinition[],
  options?: Options,
): string {
  return printFilteredSchema(
    schema,
    // Federation change: we need service and url information for the @graph directives
    serviceList,
    // Federation change: treat the directives defined by the federation spec
    // similarly to the directives defined by the GraphQL spec (ie, don't print
    // their definitions).
    (n) => !isSpecifiedDirective(n) && !isFederationDirective(n),
    isDefinedType,
    options,
  );
}

export function printIntrospectionSchema(
  schema: GraphQLSchema,
  options?: Options,
): string {
  return printFilteredSchema(
    schema,
    [],
    isSpecifiedDirective,
    isIntrospectionType,
    options,
  );
}

// Federation change: treat the types defined by the federation spec
// similarly to the directives defined by the GraphQL spec (ie, don't print
// their definitions).
function isDefinedType(type: GraphQLNamedType): boolean {
  return (
    !isSpecifiedScalarType(type) &&
    !isIntrospectionType(type) &&
    !isFederationType(type)
  );
}

function printFilteredSchema(
  schema: GraphQLSchema,
  // Federation change: we need service and url information for the @graph directives
  serviceList: ServiceDefinition[],
  directiveFilter: (type: GraphQLDirective) => boolean,
  typeFilter: (type: GraphQLNamedType) => boolean,
  options?: Options,
): string {
  const directives = schema.getDirectives().filter(directiveFilter)

  const types = Object.values(schema.getTypeMap())
    .sort((type1, type2) => type1.name.localeCompare(type2.name))
    .filter(typeFilter);

  return (
    [printSchemaDefinition(schema)]
      .concat(
        csdlDefinitions,
        printGraphs(serviceList),
        directives.map(directive => printDirective(directive, options)),
        types.map(type => printType(type, options)),
      )
      .filter(Boolean)
      .join('\n\n') + '\n'
  );
}

function printSchemaDefinition(
  schema: GraphQLSchema,
): string | undefined {
  const operationTypes = [];

  const queryType = schema.getQueryType();
  if (queryType) {
    operationTypes.push(`  query: ${queryType.name}`);
  }

  const mutationType = schema.getMutationType();
  if (mutationType) {
    operationTypes.push(`  mutation: ${mutationType.name}`);
  }

  const subscriptionType = schema.getSubscriptionType();
  if (subscriptionType) {
    operationTypes.push(`  subscription: ${subscriptionType.name}`);
  }

  return (
    'schema @using(spec: "https://specs.apollo.dev/cs/v0.1")' +
    `\n{\n${operationTypes.join('\n')}\n}`
  );
}

function printGraphs(serviceList: ServiceDefinition[]) {
  return `enum cs__Graph {${
    serviceList.map(service =>
      `\n  ${service.name} @cs__link(to: { http: { url: ${JSON.stringify(service.url)} } })`
    )
  }\n}`
}

export function printType(type: GraphQLNamedType, options?: Options): string {
  if (isScalarType(type)) {
    return printScalar(type, options);
  } else if (isObjectType(type)) {
    return printObject(type, options);
  } else if (isInterfaceType(type)) {
    return printInterface(type, options);
  } else if (isUnionType(type)) {
    return printUnion(type, options);
  } else if (isEnumType(type)) {
    return printEnum(type, options);
  } else if (isInputObjectType(type)) {
    return printInputObject(type, options);
  }

  throw Error('Unexpected type: ' + (type as GraphQLNamedType).toString());
}

function printScalar(type: GraphQLScalarType, options?: Options): string {
  return printDescription(options, type) + `scalar ${type.name}`;
}

function printObject(type: GraphQLObjectType, options?: Options): string {
  const interfaces = type.getInterfaces();
  const implementedInterfaces = interfaces.length
    ? ' implements ' + interfaces.map(i => i.name).join(' & ')
    : '';

  // Federation change: print `extend` keyword on type extensions.
  //
  // The implementation assumes that an owned type will have fields defined
  // since that is required for a valid schema. Types that are *only*
  // extensions will not have fields on the astNode since that ast doesn't
  // exist.
  //
  // XXX revist extension checking
  const isExtension =
    type.extensionASTNodes && type.astNode && !type.astNode.fields;

  return (
    printDescription(options, type) +
    (isExtension ? 'extend ' : '') +
    `type ${type.name}` +
    implementedInterfaces +
    printFields(options, type) +
    printKeys(type) +
    printFragmentsForType(type)
  );
}

// Federation change: print usages of the @owner and @key directives.
let nextKeyId = 0
function printKeys(type: GraphQLObjectType): string {
  const metadata: FederationType = type.extensions?.federation;
  if (!metadata) return '';

  const { serviceName: ownerService, keys } = metadata;
  if (!ownerService || !keys) return '';

  return (
    Object.entries(keys).map(([service, keys]) =>
      keys?.map(
          (selections) =>
            `\nfragment cs__keyFor_${type.name}_${nextKeyId++} on ${type.name} @cs__key(graph: ${service}) ${printFieldSet(selections)}`
        )
        .join(''),
    )
    .join('') + '\n'
  );
}

function printInterface(type: GraphQLInterfaceType, options?: Options): string {
  // Federation change: print `extend` keyword on type extensions.
  // See printObject for assumptions made.
  //
  // XXX revist extension checking
  const isExtension =
    type.extensionASTNodes && type.astNode && !type.astNode.fields;

  return (
    printDescription(options, type) +
    (isExtension ? 'extend ' : '') +
    `interface ${type.name}` +
    printFields(options, type) +
    printFragmentsForType(type)
  );
}

function printUnion(type: GraphQLUnionType, options?: Options): string {
  const types = type.getTypes();
  const possibleTypes = types.length ? ' = ' + types.join(' | ') : '';
  return printDescription(options, type) + 'union ' + type.name + possibleTypes;
}

function printEnum(type: GraphQLEnumType, options?: Options): string {
  const values = type
    .getValues()
    .map(
      (value, i) =>
        printDescription(options, value, '  ', !i) +
        '  ' +
        value.name +
        printDeprecated(value),
    );

  return (
    printDescription(options, type) + `enum ${type.name}` + printBlock(values)
  );
}

function printInputObject(
  type: GraphQLInputObjectType,
  options?: Options,
): string {
  const fields = Object.values(type.getFields()).map(
    (f, i) =>
      printDescription(options, f, '  ', !i) + '  ' + printInputValue(f),
  );
  return (
    printDescription(options, type) + `input ${type.name}` + printBlock(fields)
  );
}

function printFields(
  options: Options | undefined,
  type: GraphQLObjectType | GraphQLInterfaceType,
) {

  const fields = Object.values(type.getFields()).map(
    (f, i) =>
      printDescription(options, f, '  ', !i) +
      '  ' +
      f.name +
      printArgs(options, f.args, '  ') +
      ': ' +
      String(f.type) +
      printDeprecated(f) +
      printFederationFieldDirectives(type, f),
  );

  // Federation change: for entities, we want to print the block on a new line.
  // This is just a formatting nice-to-have.
  const isEntity = Boolean(type.extensions?.federation?.keys);

  return printBlock(fields, isEntity);
}

export function printWithReducedWhitespace(ast: ASTNode): string {
  return print(ast)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Federation change: print fieldsets for @key, @requires, and @provides directives
 *
 * @param selections
 */
function printFieldSet(selections: readonly SelectionNode[]): string {
  return `{ ${selections.map(printWithReducedWhitespace).join(' ')} }`;
}

/**
 * Federation change: print @resolve, @requires, and @provides directives
 *
 * @param field
 */
function printFederationFieldDirectives(
  type: GraphQLObjectType | GraphQLInterfaceType,
  field: GraphQLField<any, any>,
): string {
  if (!field.extensions?.federation) {
    const {serviceName}: FederationType = type.extensions?.federation;
    return ` @cs__resolve(graph: ${serviceName})`
  }

  const {
    serviceName,
    requires = [],
    provides = [],
  }: FederationField = field.extensions.federation;

  return ` @cs__resolve(graph: ${serviceName}${
    requires.length ?
      `, requires: "${findOrCreateFragment(type, requires)}"`
      : ''
  }${
    provides.length ?
      `, provides: "${findOrCreateFragment(type, provides)}"`
      : ''
  })`
}

type FragmentSource = (GraphQLObjectType | GraphQLInterfaceType) & {
  fragments?: Map<string, { id: string, text: string }>,
  nextFragmentId?: number
}

function findOrCreateFragment(
  type: FragmentSource,
  selections: readonly SelectionNode[]
): string {
  type.fragments ??= new Map;
  type.nextFragmentId ??= 0;

  const key = printFieldSet(selections);
  const existing = type.fragments.get(key);
  if (existing) return existing.id;

  const id = `cs__fragmentOn_` + asValidIdentifier(`${type}_${key}_${type.nextFragmentId++}`);

  type.fragments.set(id,
    { id, text: `fragment ${id} on ${type.name} ${printFieldSet(selections)}` });
  return id;
}

function asValidIdentifier(input: string) {
  return input.trim()
    .replace(/(\s|,|{|})+/g, '_')
    .replace(/_+/g, '_')
    .replace(/[^A-Za-z_0-9]/g, '');
}

function printFragmentsForType(type: FragmentSource) {
  return [...type.fragments?.values() ?? []].map(f => `\n${f.text}`).join();
}

// Federation change: `onNewLine` is a formatting nice-to-have for printing
// types that have a list of directives attached, i.e. an entity.
function printBlock(items: string[], onNewLine?: boolean) {
  return items.length !== 0
    ? onNewLine
      ? '\n{\n' + items.join('\n') + '\n}'
      : ' {\n' + items.join('\n') + '\n}'
    : '';
}

function printArgs(
  options: Options | undefined,
  args: GraphQLArgument[],
  indentation = '',
) {
  if (args.length === 0) {
    return '';
  }

  // If every arg does not have a description, print them on one line.
  if (args.every((arg) => !arg.description)) {
    return '(' + args.map(printInputValue).join(', ') + ')';
  }

  return (
    '(\n' +
    args
      .map(
        (arg, i) =>
          printDescription(options, arg, '  ' + indentation, !i) +
          '  ' +
          indentation +
          printInputValue(arg),
      )
      .join('\n') +
    '\n' +
    indentation +
    ')'
  );
}

function printInputValue(arg: GraphQLInputField) {
  const defaultAST = astFromValue(arg.defaultValue, arg.type);
  let argDecl = arg.name + ': ' + String(arg.type);
  if (defaultAST) {
    argDecl += ` = ${print(defaultAST)}`;
  }
  return argDecl;
}

function printDirective(directive: GraphQLDirective, options?: Options) {
  return (
    printDescription(options, directive) +
    'directive @' +
    directive.name +
    printArgs(options, directive.args) +
    (directive.isRepeatable ? ' repeatable' : '') +
    ' on ' +
    directive.locations.join(' | ')
  );
}

function printDeprecated(
  fieldOrEnumVal: GraphQLField<any, any> | GraphQLEnumValue,
) {
  if (!fieldOrEnumVal.isDeprecated) {
    return '';
  }
  const reason = fieldOrEnumVal.deprecationReason;
  const reasonAST = astFromValue(reason, GraphQLString);
  if (reasonAST && reason !== DEFAULT_DEPRECATION_REASON) {
    return ' @deprecated(reason: ' + print(reasonAST) + ')';
  }
  return ' @deprecated';
}

function printDescription<T extends { description?: Maybe<string> }>(
  options: Options | undefined,
  def: T,
  indentation = '',
  firstInBlock = true,
): string {
  const { description } = def;
  if (description == null) {
    return '';
  }

  if (options?.commentDescriptions === true) {
    return printDescriptionWithComments(description, indentation, firstInBlock);
  }

  const preferMultipleLines = description.length > 70;
  const blockString = printBlockString(description, '', preferMultipleLines);
  const prefix =
    indentation && !firstInBlock ? '\n' + indentation : indentation;

  return prefix + blockString.replace(/\n/g, '\n' + indentation) + '\n';
}

function printDescriptionWithComments(
  description: string,
  indentation: string,
  firstInBlock: boolean,
) {
  const prefix = indentation && !firstInBlock ? '\n' : '';
  const comment = description
    .split('\n')
    .map((line) => indentation + (line !== '' ? '# ' + line : '#'))
    .join('\n');

  return prefix + comment + '\n';
}

/**
 * Print a block string in the indented block form by adding a leading and
 * trailing blank line. However, if a block string starts with whitespace and is
 * a single-line, adding a leading blank line would strip that whitespace.
 *
 * @internal
 */
export function printBlockString(
  value: string,
  indentation: string = '',
  preferMultipleLines: boolean = false,
): string {
  const isSingleLine = value.indexOf('\n') === -1;
  const hasLeadingSpace = value[0] === ' ' || value[0] === '\t';
  const hasTrailingQuote = value[value.length - 1] === '"';
  const hasTrailingSlash = value[value.length - 1] === '\\';
  const printAsMultipleLines =
    !isSingleLine ||
    hasTrailingQuote ||
    hasTrailingSlash ||
    preferMultipleLines;

  let result = '';
  // Format a multi-line block quote to account for leading space.
  if (printAsMultipleLines && !(isSingleLine && hasLeadingSpace)) {
    result += '\n' + indentation;
  }
  result += indentation ? value.replace(/\n/g, '\n' + indentation) : value;
  if (printAsMultipleLines) {
    result += '\n';
  }

  return '"""' + result.replace(/"""/g, '\\"""') + '"""';
}
