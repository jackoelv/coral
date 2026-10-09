// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {Ownable2Step} from "../lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {ERC721} from "../lib/openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "../lib/openzeppelin-contracts/contracts/interfaces/IERC165.sol";
import {IERC4906} from "../lib/openzeppelin-contracts/contracts/interfaces/IERC4906.sol";
import {Base64} from "../lib/openzeppelin-contracts/contracts/utils/Base64.sol";
import {Strings} from "../lib/openzeppelin-contracts/contracts/utils/Strings.sol";

interface ICoralVaultSettle {
    function settleTransfer(address from, address to) external;
}

/// @title FreeDaoNFT
/// @notice One token per 500 USDT of self volume, minted by the vault.
///         Transfers are locked until the owner calls `setTransfersEnabled(true)`.
///         Weekly yield is paid by FreeDaoNFTInterest and follows the current holder.
///         Every token shares one image; the owner can replace its URL at any time.
contract FreeDaoNFT is ERC721, Ownable2Step, IERC4906 {
    address public minter;
    uint256 public nextId;
    string public imageURI;
    bool public transfersEnabled;

    event MinterUpdated(address indexed minter);
    event ImageURIUpdated(string imageURI);
    event TransfersEnabledUpdated(bool enabled);

    error ZeroAddress();
    error NotAuthorized();
    error TransfersLocked();
    error ZeroCount();
    error MinterAlreadySet();
    error InvalidImageURI();

    constructor(
        address initialOwner,
        string memory name_,
        string memory symbol_
    ) ERC721(name_, symbol_) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    /// @notice The vault is the only minter, and the address can be set only once.
    function setMinter(
        address minter_
    ) external onlyOwner {
        if (minter != address(0)) revert MinterAlreadySet();
        if (minter_ == address(0)) revert ZeroAddress();
        minter = minter_;
        emit MinterUpdated(minter_);
    }

    /// @notice Replace the shared image. Wallets and explorers re-read metadata via ERC-4906.
    function setImageURI(
        string calldata imageURI_
    ) external onlyOwner {
        _checkImageURI(bytes(imageURI_));
        imageURI = imageURI_;
        emit ImageURIUpdated(imageURI_);
        if (nextId != 0) emit BatchMetadataUpdate(1, nextId);
    }

    /// @notice Open or close holder-to-holder transfers. Minting stays allowed either way.
    function setTransfersEnabled(
        bool enabled
    ) external onlyOwner {
        transfersEnabled = enabled;
        emit TransfersEnabledUpdated(enabled);
        if (nextId != 0) emit BatchMetadataUpdate(1, nextId);
    }

    function mint(
        address to,
        uint256 count
    ) external {
        if (msg.sender != minter) revert NotAuthorized();
        if (to == address(0)) revert ZeroAddress();
        if (count == 0) revert ZeroCount();
        for (uint256 i = 0; i < count;) {
            unchecked {
                ++nextId;
                ++i;
            }
            _mint(to, nextId);
        }
    }

    /// @notice On-chain JSON. Only the image points off-chain.
    function tokenURI(
        uint256 tokenId
    ) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory id = Strings.toString(tokenId);
        string memory note = transfersEnabled ? "Transferable." : "Non-transferable.";
        string memory transferable = transfersEnabled ? "Yes" : "No";
        bytes memory json = abi.encodePacked(
            '{"name":"FREEDAO RWA Pass #',
            id,
            '","description":"FREEDAO RWA Pass. ',
            note,
            ' Face value 500 USDT.","image":"',
            imageURI,
            '","attributes":[{"trait_type":"Face value","value":"500 USDT"},',
            '{"trait_type":"Transferable","value":"',
            transferable,
            '"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(json));
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721, IERC165) returns (bool) {
        return interfaceId == bytes4(0x49064906) || super.supportsInterface(interfaceId);
    }

    /// @dev Mint path: the vault settles interest itself before calling `mint`.
    ///      Transfer path: settle both sides via the vault before the balance moves,
    ///      so weekly interest is paid once per week per token and never retroactively
    ///      to a buyer who did not hold during those weeks.
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            if (!transfersEnabled) revert TransfersLocked();
            ICoralVaultSettle(minter).settleTransfer(from, to);
        }
        return super._update(to, tokenId, auth);
    }

    /// @dev The URL is spliced into JSON unescaped, so quotes, backslashes and control bytes are rejected.
    function _checkImageURI(
        bytes memory uri
    ) private pure {
        if (uri.length == 0) revert InvalidImageURI();
        for (uint256 i = 0; i < uri.length; i++) {
            bytes1 c = uri[i];
            if (c < 0x20 || c == 0x22 || c == 0x5c || c == 0x7f) revert InvalidImageURI();
        }
    }
}
