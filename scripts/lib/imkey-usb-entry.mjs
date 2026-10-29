import TransportWebUSB from "@imkey/web3-provider/dist/hw-transport-webusb/TransportWebUSB.js";
import Eth from "@imkey/web3-provider/dist/hw-app-eth/Eth.js";

const PATH = "m/44'/60'/0'/0/0";

let open = null;

export async function connectImKey() {
  if (!navigator.usb) throw new Error("请用 Chrome 打开这个页面。Safari 不能连接 imKey。");
  if (open) {
    await open.transport.close().catch(() => {});
    open = null;
  }
  const transport = await TransportWebUSB.request();
  const eth = new Eth(transport);
  const { address } = await eth.getAddress(PATH);
  open = { transport, eth };
  return address;
}

export async function signImKey(transaction) {
  if (!open) throw new Error("还没连接 imKey");
  const signed = await open.eth.signTransaction({ ...transaction, path: PATH });
  return signed.signature;
}
