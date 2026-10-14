import { handleDemoPrivateProjection } from './platform-private-projection-handler.js';

export const DEMO_PRODUCT_DELIVERY_PATH = '/api/v1/platform/demo/product-delivery';

export function handleDemoProductDelivery({ productDelivery, ...options }) {
  return handleDemoPrivateProjection({
    ...options,
    projection: productDelivery,
    path: DEMO_PRODUCT_DELIVERY_PATH,
    unavailableCode: 'PLATFORM_PRODUCT_DELIVERY_UNAVAILABLE',
  });
}
