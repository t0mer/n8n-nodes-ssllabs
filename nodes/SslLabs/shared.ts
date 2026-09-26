import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

/** A per-item operation handler. Returns one or more output objects for item `i`. */
export type OperationHandler = (
	ctx: IExecuteFunctions,
	i: number,
) => Promise<IDataObject | IDataObject[]>;

/** An operation that processes all input items at once (e.g. with bounded concurrency). */
export type BatchHandler = (ctx: IExecuteFunctions) => Promise<INodeExecutionData[]>;

export interface ResourceModule {
	properties: INodeProperties[];
	handlers: Record<string, OperationHandler>;
	batchHandlers?: Record<string, BatchHandler>;
}

/** Attaches the item index to n8n errors, or wraps anything else in a NodeOperationError. */
export function toNodeError(ctx: IExecuteFunctions, error: Error, itemIndex: number) {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) {
		error.context.itemIndex = itemIndex;
		return error;
	}
	return new NodeOperationError(ctx.getNode(), error, { itemIndex });
}

/** The continue-on-fail output item: `{ error, host? }` paired to its input. */
export function errorItem(
	ctx: IExecuteFunctions,
	error: Error,
	itemIndex: number,
): INodeExecutionData {
	let host = '';
	try {
		const value = ctx.getNodeParameter('host', itemIndex, '');
		host = typeof value === 'string' ? value : '';
	} catch {
		// Operations without a Host parameter, or an unresolvable expression.
	}
	return {
		json: { error: error.message, ...(host ? { host } : {}) },
		pairedItem: { item: itemIndex },
	};
}
