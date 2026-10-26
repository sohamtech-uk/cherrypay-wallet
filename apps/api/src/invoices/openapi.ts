import { allocationSchema, invoiceInputSchema } from './routes.js';
const text={type:'string'},integer={type:'integer'},amount={type:'string',pattern:'^[0-9]+$'};
const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
const receipt={type:'object',required:['eventId','transactionHash','from','amountStroops','ledger','closedAt'],properties:{eventId:text,transactionHash:text,from:text,amountStroops:amount,ledger:integer,closedAt:integer}};
export const invoiceSchemas={
  InvoiceInput:invoiceInputSchema,
  Invoice:{type:'object',required:['id','network','asset','assetContract','invoiceReference','merchantName','destination','amountStroops','paidStroops','remainingStroops','status','expiresAt','expired','paymentPending','createdAt'],properties:{
    id:text,network:{const:'TESTNET'},asset:{const:'XLM'},assetContract:text,invoiceReference:text,merchantName:text,destination:text,amountStroops:amount,paidStroops:amount,remainingStroops:amount,
    status:{enum:['unpaid','partially_paid','paid','overpaid']},expiresAt:integer,expired:{type:'boolean'},paymentPending:{type:'boolean'},createdAt:integer
  }},
  InvoiceDetail:{allOf:[ref('Invoice'),{
    type:'object',required:['walletId','receipts','receiptsTruncated'],properties:{
      walletId:text,receiptsTruncated:{type:'boolean'},
      receipts:{type:'array',maxItems:100,items:{
        ...receipt,required:[...receipt.required,'method','actor','note','allocatedAt','late'],
        properties:{...receipt.properties,method:{enum:['checkout','manual']},actor:text,note:text,allocatedAt:integer,late:{type:'boolean'}}
      }}
    }
  }]},
  InvoicePage:{type:'object',required:['network','items'],properties:{network:{const:'TESTNET'},items:{type:'array',maxItems:20,items:ref('Invoice')},nextCursor:text}},
  UnmatchedReceipts:{type:'object',required:['network','items'],properties:{network:{const:'TESTNET'},items:{type:'array',maxItems:20,items:receipt},nextCursor:text}}
};
function operation(summary:string,response:object,body?:object,publicRead=false) {
  return {summary,security:publicRead?[]:[{WalletSession:[]}],...(body?{requestBody:{required:true,content:{'application/json':{schema:body}}}}:{}),responses:{
    '200':{description:'Persisted invoice data. Only independently verified native XLM receipts affect settlement.',content:{'application/json':{schema:response}}},
    '400':{description:'Invalid request'},'401':{description:'Authentication required'},'403':{description:'Untrusted mutation origin'},'404':{description:'Resource not found or not owned'},'409':{description:'Invoice conflict, receipt already allocated, or unresolved payment'},'503':{description:'Invoice service unavailable'}
  }};
}
const wallet={name:'walletId',in:'path',required:true,schema:text},id={name:'requestId',in:'path',required:true,schema:text},cursor={name:'cursor',in:'query',schema:text};
const base='/api/v1/wallets/{walletId}/invoices';
export const invoicePaths={
  '/api/v1/payment-requests/{requestId}':{parameters:[id],get:operation('Read checkout terms from an unguessable payment link; excludes payer and receipt history',ref('Invoice'),undefined,true)},
  [base]:{parameters:[wallet],post:operation('Save or recover immutable invoice request by merchant wallet and invoice reference',ref('InvoiceDetail'),ref('InvoiceInput')),get:{...operation('List owned invoice payment requests',ref('InvoicePage')),parameters:[cursor]}},
  [`${base}/{requestId}`]:{parameters:[wallet,id],get:operation('Read owned invoice and allocated receipts',ref('InvoiceDetail'))},
  [`${base}/{requestId}/allocate`]:{parameters:[wallet,id],post:operation('Assign an entire verified unmatched receipt once, with an audit note',ref('InvoiceDetail'),allocationSchema)},
  '/api/v1/wallets/{walletId}/unmatched-receipts':{parameters:[wallet],get:{...operation('List verified incoming native XLM receipts without invoice allocation',ref('UnmatchedReceipts')),parameters:[cursor]}}
};
