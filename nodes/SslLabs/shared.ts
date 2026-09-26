import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';

/** A per-item operation handler. Returns one or more output objects for item `i`. */
export type OperationHandler = (
	ctx: IExecuteFunctions,
	i: number,
) => Promise<IDataObject | IDataObject[]>;

export interface ResourceModule {
	properties: INodeProperties[];
	handlers: Record<string, OperationHandler>;
}
